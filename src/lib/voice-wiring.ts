import {
  onVoiceDictation,
  onVoiceFocusRequest,
  onVoiceIndicator,
  onVoiceInsert,
  onVoiceModelProgress,
  voiceDictationToggle,
  voiceFocusResponse,
  voiceInsertResult,
  voiceTtsStop
} from '@/tauri/voice'
import { createTtsStopper, newlyFocusedTerminal } from '@/lib/voice-tts'
import { DICTATION_ALERT_ID, dictationFailure } from '@/lib/voice-dictation'
import { writeTerminalChecked } from '@/tauri/terminal'
import { devLog } from '@/lib/dev-log'
import { dictationTarget } from '@/lib/voice-focus'
import { deliverDictation } from '@/lib/voice-delivery'
import { describeFocusedElement } from '@/lib/terminal-focus'
import {
  getTerminalAgentId,
  getTerminalDraftInfo,
  isAnyTerminalFocused,
  resetTerminalInputSegment,
  setUserInputHandler
} from '@/lib/terminal-registry'
import { SUBMIT_DELAY_MS } from '@/lib/war-room-delivery'
import { useAppStore, selectFocusedTerminalId } from '@/store/app-store'
import { useDocumentStore } from '@/store/document-store'
import { useAgentStateStore } from '@/store/agent-state-store'
import { useTerminalTypingStore } from '@/store/terminal-typing-store'
import { useTerminalTitleStore } from '@/store/terminal-title-store'
import { useNotificationCenterStore } from '@/store/notification-center-store'
import { useVoiceIndicatorStore } from '@/store/voice-indicator-store'
import { useVoiceDictationStore } from '@/store/voice-dictation-store'

/** Notification copy for a dictation that did not land. */
const REASON_COPY: Record<string, string> = {
  'target-gone': 'pane closed or restarted',
  'target-busy': 'agent is waiting for input',
  composing: 'input method still composing',
  'write-failed': 'write failed'
}

/**
 * Answers Rust's voice requests for this window (SWA-12). Only the OS
 * foreground window answers a focus request; others stay silent and Rust
 * times out to "no-focus". Returns the unsubscribe for `useEffect`.
 */
export function wireVoice(isSettingsOpen: () => boolean): () => void {
  const focus = onVoiceFocusRequest((requestId) => {
    if (!document.hasFocus()) return
    const app = useAppStore.getState()
    const workspace = app.workspaces.find((w) => w.id === app.activeWorkspaceId)
    const pane = workspace ? useDocumentStore.getState().panes[workspace.focusedLeafId] : undefined
    const candidate = selectFocusedTerminalId(app) ?? null
    const terminalId = dictationTarget({
      windowFocused: true,
      settingsOpen: isSettingsOpen(),
      welcomeFocused: app.welcomeFocused,
      editorPane: pane?.active != null && pane.keyboard === 'file',
      focused: describeFocusedElement(document.activeElement),
      inTerminal: isAnyTerminalFocused(),
      terminalId: candidate
    })
    void voiceFocusResponse(requestId, {
      terminalId,
      name: terminalId ? (useTerminalTitleStore.getState().titles[terminalId] ?? null) : null,
      agentId: terminalId ? (getTerminalAgentId(terminalId) ?? null) : null
    })
  })

  const insert = onVoiceInsert((e) => {
    void deliverDictation(e, {
      draftInfo: getTerminalDraftInfo,
      agentState: (id) => useAgentStateStore.getState().byId[id]?.state,
      write: writeTerminalChecked,
      resetInput: resetTerminalInputSegment,
      markDraft: (id, now) => useTerminalTypingStore.getState().markDraft(id, now),
      inputStamp: (id) => useTerminalTypingStore.getState().lastKeyAt[id],
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      submitDelayMs: SUBMIT_DELAY_MS
    }).then((out) => {
      void voiceInsertResult(e.requestId, out)
      if (!out.ok) {
        useNotificationCenterStore.getState().add({
          kind: 'dictation',
          terminalId: e.terminalId,
          title: `Dictation not inserted: ${REASON_COPY[out.reason ?? ''] ?? out.reason ?? 'unknown'}`,
          detail: useTerminalTitleStore.getState().titles[e.terminalId] ?? '',
          at: Date.now()
        })
      }
    })
  })

  const indicator = onVoiceIndicator((e) => useVoiceIndicatorStore.getState().apply(e))

  // Built-in speech source (SWA-38). A refused insert already raised its own
  // notification above (same voice:insert path); this covers what happens
  // before it: no speech, no microphone, cancelled by a server-side end.
  const dictation = onVoiceDictation((e) => {
    // Phases only, never text: the dev log is how a silent failure is traced.
    devLog('voice.dictation', { state: e.state, terminalId: e.terminalId, reason: e.reason })
    useVoiceDictationStore.getState().applyEvent(e)
    if (e.state !== 'idle' || INSERT_REASONS.has(e.reason ?? '')) return
    reportDictation(e.reason, e.terminalId)
  })
  const progress = onVoiceModelProgress((e) => useVoiceDictationStore.getState().applyProgress(e))
  void useVoiceDictationStore.getState().refresh()

  // Announcements (SWA-66) stop when the user types, and a pane's own
  // announcement stops when the user focuses that pane.
  setUserInputHandler(createTtsStopper(() => void voiceTtsStop().catch(() => {})))
  const focusWatch = useAppStore.subscribe((s, prev) => {
    const id = newlyFocusedTerminal(selectFocusedTerminalId(prev), selectFocusedTerminalId(s))
    if (id) void voiceTtsStop(id).catch(() => {})
  })

  return () => {
    setUserInputHandler(undefined)
    focusWatch()
    void focus.then((off) => off())
    void indicator.then((off) => off())
    void insert.then((off) => off())
    void dictation.then((off) => off())
    void progress.then((off) => off())
  }
}

/** Reasons `deliverDictation` reports itself, so they are not shown twice. */
const INSERT_REASONS = new Set(Object.keys(REASON_COPY))

function reportDictation(reason: string | undefined, terminalId: string | undefined): void {
  const copy = dictationFailure(reason)
  if (!copy) return
  useNotificationCenterStore.getState().add({
    kind: 'dictation',
    terminalId: terminalId ?? DICTATION_ALERT_ID,
    title: `Dictation: ${copy}`,
    detail: terminalId ? (useTerminalTitleStore.getState().titles[terminalId] ?? '') : '',
    at: Date.now()
  })
}

/** Shortcut: silence every announcement now (SWA-66). */
export function stopAnnouncements(): void {
  void voiceTtsStop().catch(() => {})
}

/** Shortcut and pane button: start, or stop and transcribe. */
export function toggleDictation(): void {
  voiceDictationToggle().catch((e) => {
    devLog('voice.dictation.refused', { reason: String(e) }, 'warn')
    reportDictation(String(e), undefined)
  })
}

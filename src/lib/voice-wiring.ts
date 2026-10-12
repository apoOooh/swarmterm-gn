import { onVoiceFocusRequest, onVoiceInsert, voiceFocusResponse, voiceInsertResult } from '@/tauri/voice'
import { writeTerminalChecked } from '@/tauri/terminal'
import { dictationTarget } from '@/lib/voice-focus'
import { deliverDictation } from '@/lib/voice-delivery'
import { describeFocusedElement } from '@/lib/terminal-focus'
import {
  getTerminalAgentId,
  getTerminalDraftInfo,
  isAnyTerminalFocused,
  resetTerminalInputSegment
} from '@/lib/terminal-registry'
import { SUBMIT_DELAY_MS } from '@/lib/war-room-delivery'
import { useAppStore, selectFocusedTerminalId } from '@/store/app-store'
import { useDocumentStore } from '@/store/document-store'
import { useAgentStateStore } from '@/store/agent-state-store'
import { useTerminalTypingStore } from '@/store/terminal-typing-store'
import { useTerminalTitleStore } from '@/store/terminal-title-store'
import { useNotificationCenterStore } from '@/store/notification-center-store'

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

  return () => {
    void focus.then((off) => off())
    void insert.then((off) => off())
  }
}

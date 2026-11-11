import { onPromptBlocked, onPromptResubmit } from '@/tauri/prompt-resubmit'
import { writeTerminalChecked } from '@/tauri/terminal'
import { createAutoSendLimiter, deliverResubmit, effectiveResubmitMode } from '@/lib/prompt-resubmit'
import { resubmitHeldEntry } from '@/lib/backend-alerts'
import { useNotificationCenterStore } from '@/store/notification-center-store'
import { devLog } from '@/lib/dev-log'
import {
  getTerminalDraftInfo,
  noteAgentHook,
  paneDraftText,
  paneHasPromptDraft,
  resetTerminalInputSegment
} from '@/lib/terminal-registry'
import { SUBMIT_DELAY_MS } from '@/lib/war-room-delivery'
import { useAgentStateStore } from '@/store/agent-state-store'
import { useAgentPolicyStore } from '@/store/agent-policy-store'
import { usePolicyStore } from '@/store/policy-store'
import { useTerminalTypingStore } from '@/store/terminal-typing-store'
import { usePromptResubmitStore } from '@/store/prompt-resubmit-store'

/** Hex SHA-256 of the UTF-8 bytes; the result is compared, never kept or logged. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * SWA-88 wiring for the main window (`App.tsx`). Two events:
 *
 * - `agent:prompt-blocked`: the blocked prompt had already driven the pane
 *   to "working". It goes back to idle as SEEN first, so the transition is
 *   no completion — no "done" badge, bell entry or announcement for a
 *   prompt the agent never got. Only then the detector hears the idle edge
 *   (its own republish is then the same state, a no-op).
 * - `prompt:resubmit`: put the masked text back (`deliverResubmit`); a
 *   fallback offers it in the pane's pill. Outcomes are logged without text.
 *   It needs a real Enter key of the user in that pane just before (typing
 *   store `submitAnchor`; any input since moves `inputRev` and stops it) and
 *   a visible restored draft (matched against the blocked prompt's
 *   fingerprint where it reads back exactly). A second attempt with Enter in
 *   the same pane within 30 s is withheld (inserted only) and the bell says so.
 */
export function wirePromptResubmit(): () => void {
  const claimAutoSend = createAutoSendLimiter()
  const blocked = onPromptBlocked((e) => {
    useAgentStateStore.getState().publish(e.terminalId, 'idle', { paneWatched: true, nowMs: Date.now() })
    noteAgentHook(e.terminalId, 'idle')
  })

  const resubmit = onPromptResubmit((e) => {
    usePromptResubmitStore.getState().dismiss(e.terminalId)
    void deliverResubmit(e, {
      mode: () => effectiveResubmitMode(useAgentPolicyStore.getState().policy.promptResubmit, usePolicyStore.getState().policy),
      draftInfo: getTerminalDraftInfo,
      agentState: (id) => useAgentStateStore.getState().byId[id]?.state,
      boxHasDraft: paneHasPromptDraft,
      draftText: paneDraftText,
      takeUserSubmit: (id, now, maxAge) => useTerminalTypingStore.getState().takeSubmit(id, now, maxAge),
      sha256: sha256Hex,
      inputRevision: (id) => useTerminalTypingStore.getState().inputRev[id],
      inputStamp: (id) => useTerminalTypingStore.getState().lastKeyAt[id],
      inputDirty: (id) => useTerminalTypingStore.getState().dirty[id] === true,
      claimAutoSend,
      write: writeTerminalChecked,
      resetInput: resetTerminalInputSegment,
      markDraft: (id, now) => useTerminalTypingStore.getState().markDraft(id, now),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      submitDelayMs: SUBMIT_DELAY_MS
    }).then((out) => {
      devLog('prompt.resubmit', { terminalId: e.terminalId, outcome: out.kind, reason: 'reason' in out ? out.reason : undefined })
      if (out.kind === 'fallback') usePromptResubmitStore.getState().offer(e.terminalId, e.text)
      if (out.kind === 'inserted' && out.rateLimited) useNotificationCenterStore.getState().add(resubmitHeldEntry(Date.now()))
    })
  })

  return () => {
    void blocked.then((off) => off())
    void resubmit.then((off) => off())
  }
}

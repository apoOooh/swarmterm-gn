import { onPromptBlocked, onPromptResubmit } from '@/tauri/prompt-resubmit'
import { writeTerminalChecked } from '@/tauri/terminal'
import { deliverResubmit, effectiveResubmitMode } from '@/lib/prompt-resubmit'
import { devLog } from '@/lib/dev-log'
import {
  getTerminalDraftInfo,
  noteAgentHook,
  paneHasPromptDraft,
  resetTerminalInputSegment
} from '@/lib/terminal-registry'
import { SUBMIT_DELAY_MS } from '@/lib/war-room-delivery'
import { useAgentStateStore } from '@/store/agent-state-store'
import { useAgentPolicyStore } from '@/store/agent-policy-store'
import { usePolicyStore } from '@/store/policy-store'
import { useTerminalTypingStore } from '@/store/terminal-typing-store'
import { usePromptResubmitStore } from '@/store/prompt-resubmit-store'

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
 */
export function wirePromptResubmit(): () => void {
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
      inputStamp: (id) => useTerminalTypingStore.getState().lastKeyAt[id],
      write: writeTerminalChecked,
      resetInput: resetTerminalInputSegment,
      markDraft: (id, now) => useTerminalTypingStore.getState().markDraft(id, now),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      submitDelayMs: SUBMIT_DELAY_MS
    }).then((out) => {
      devLog('prompt.resubmit', { terminalId: e.terminalId, outcome: out.kind, reason: 'reason' in out ? out.reason : undefined })
      if (out.kind === 'fallback') usePromptResubmitStore.getState().offer(e.terminalId, e.text)
    })
  })

  return () => {
    void blocked.then((off) => off())
    void resubmit.then((off) => off())
  }
}

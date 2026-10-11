/**
 * One-shot delivery of a handoff brief (SWA-22) into the new pane. Wiring
 * outside React like war-room-delivery: the dialog may close while a typing
 * hold is pending, and the brief must still arrive (or fail) exactly once.
 *
 * Same write path as every renderer-authored prompt: `deliverPromptToTerminal`
 * (sanitised, bracketed paste, no Enter) then `submitTerminalPrompt` as its own
 * later flush. Same hold rule as War Room deliveries (`deliveryHoldReason`):
 * agent working/blocked or the user typing in that pane holds the single
 * attempt; it is re-checked, never repeated. Before each write the pty
 * generation and status are compared with what the user confirmed against.
 */
import { deliverPromptToTerminal, getTerminalGeneration, getTerminalStatus, submitTerminalPrompt } from '@/lib/terminal-registry'
import { submitBlocker } from '@/lib/handoff-flow'
import { NUDGE_IDLE_MS, deliveryHoldReason, type HoldReason } from '@/lib/war-room-nudge'
import { HOLD_RECHECK_MS, SUBMIT_DELAY_MS } from '@/lib/war-room-delivery'
import { useAgentStateStore } from '@/store/agent-state-store'
import { selectFocusedTerminalId, useAppStore } from '@/store/app-store'
import { useTerminalActivityStore } from '@/store/terminal-activity-store'
import { useTerminalTypingStore } from '@/store/terminal-typing-store'

export interface HandoffDeliveryCallbacks {
  held: (reason: HoldReason | undefined) => void
  delivered: (at: number) => void
  /** Body is in the prompt but Enter was withheld (see submitBlocker). */
  pasted: (reason: string) => void
  failed: (error: string) => void
}

function sameProcess(terminalId: string, generation: number | undefined): boolean {
  return getTerminalStatus(terminalId).kind === 'running' && getTerminalGeneration(terminalId) === generation
}

function agentState(terminalId: string) {
  return useAgentStateStore.getState().byId[terminalId]?.state
}

function holdReason(terminalId: string): HoldReason | null {
  const typing = useTerminalTypingStore.getState()
  return deliveryHoldReason(
    {
      focused: selectFocusedTerminalId(useAppStore.getState()) === terminalId,
      lastKeyAt: typing.lastKeyAt[terminalId],
      dirty: typing.dirty[terminalId] ?? false,
      agentState: useAgentStateStore.getState().byId[terminalId]?.state
    },
    Date.now()
  )
}

/** Starts the single attempt; the returned function cancels it if still pending. */
export function deliverHandoffBrief(
  terminalId: string,
  generation: number | undefined,
  text: string,
  cb: HandoffDeliveryCallbacks
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false
  // A freshly started CLI prints its banner first; wait for sustained output
  // quiet like a War Room nudge so the paste does not land mid-boot.
  let quietSince: number | undefined

  const finish = (fn: () => void): void => {
    if (done) return
    done = true
    fn()
  }

  const check = (): void => {
    timer = undefined
    if (done) return
    if (!sameProcess(terminalId, generation)) {
      finish(() => cb.failed('The new pane stopped or restarted; the brief was not sent.'))
      return
    }
    // Never paste into a plain shell: without an agent the brief's lines run as commands.
    const agent = agentState(terminalId)
    if (agent === undefined || agent === 'unknown') {
      finish(() => cb.failed('The agent in the new pane is not running; the brief was not sent.'))
      return
    }
    const reason = holdReason(terminalId)
    cb.held(reason ?? undefined)
    const now = Date.now()
    if (useTerminalActivityStore.getState().active[terminalId]) quietSince = undefined
    else quietSince ??= now
    if (reason !== null || quietSince === undefined || now - quietSince < NUDGE_IDLE_MS) {
      timer = setTimeout(check, HOLD_RECHECK_MS)
      return
    }
    // From here on there is no going back: the body is written exactly once.
    done = true
    deliverPromptToTerminal(terminalId, text)
    timer = setTimeout(() => {
      timer = undefined
      // Re-check everything the paste was gated on: the user may have typed
      // into the pasted prompt, or a permission prompt may have appeared —
      // Enter would then submit their text or approve the prompt.
      const blocker = submitBlocker({
        running: getTerminalStatus(terminalId).kind === 'running',
        generation: getTerminalGeneration(terminalId),
        expectedGeneration: generation,
        hold: holdReason(terminalId),
        agent: agentState(terminalId)
      })
      if (blocker !== null) {
        cb.pasted(blocker)
        return
      }
      submitTerminalPrompt(terminalId)
      cb.delivered(Date.now())
    }, SUBMIT_DELAY_MS)
  }

  timer = setTimeout(check, 0)
  return () => {
    if (timer !== undefined && !done) {
      clearTimeout(timer)
      done = true
    }
  }
}

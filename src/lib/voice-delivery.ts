import type { AgentEngineState } from '@/lib/agent-state/types'
import { insertRejection, prepareDictationBody, shouldSubmitDictation } from '@/lib/voice-insert'

/**
 * One dictated insert, end to end on the renderer side (SWA-12). Rust has
 * already redeemed the pin and checked the pane; this writes the draft
 * through the generation-checked command and reports the outcome, which Rust
 * relays to buzzkey as the ACK.
 *
 * Dependencies are injected so the whole sequence is unit-testable without
 * xterm or IPC (`voice-delivery.test.ts`); `App.tsx` wires the real ones.
 */

export interface DictationRequest {
  requestId: string
  terminalId: string
  expectedSpawnId: string
  text: string
  /** Already ANDed with the "allow auto-Enter" setting by Rust. */
  submit: boolean
}

export interface DictationOutcome {
  ok: boolean
  reason?: string
  /** True when a delayed Enter was scheduled (it may still stand down). */
  submitScheduled?: boolean
}

export interface DictationDeps {
  draftInfo: (id: string) => { bracketed: boolean; composing: boolean } | undefined
  agentState: (id: string) => AgentEngineState | undefined
  write: (id: string, expectedSpawnId: string, data: string) => Promise<void>
  resetInput: (id: string) => void
  markDraft: (id: string, nowMs: number) => number
  inputStamp: (id: string) => number | undefined
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Gap before the Enter; agent TUIs swallow one glued to the paste. */
  submitDelayMs: number
}

/** How long an open IME composition may delay the insert before it is refused. */
export const COMPOSITION_WAIT_MS = 5000
const COMPOSITION_POLL_MS = 100

function reasonOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return text.startsWith('target-gone') ? 'target-gone' : text.startsWith('write-failed') ? 'write-failed' : text
}

export async function deliverDictation(req: DictationRequest, deps: DictationDeps): Promise<DictationOutcome> {
  let info = deps.draftInfo(req.terminalId)
  if (!info) return { ok: false, reason: 'target-gone' }
  const rejection = insertRejection(deps.agentState(req.terminalId))
  if (rejection) return { ok: false, reason: rejection }

  // Text written mid-composition would be replaced by the composition's own
  // commit, so wait for it to end — but never forever.
  for (let waited = 0; info.composing; waited += COMPOSITION_POLL_MS) {
    if (waited >= COMPOSITION_WAIT_MS) return { ok: false, reason: 'composing' }
    await deps.sleep(COMPOSITION_POLL_MS)
    info = deps.draftInfo(req.terminalId)
    if (!info) return { ok: false, reason: 'target-gone' }
  }
  // The wait may have let the agent reach a permission prompt.
  const late = insertRejection(deps.agentState(req.terminalId))
  if (late) return { ok: false, reason: late }

  const bracketed = info.bracketed
  // Mark the draft BEFORE the write's IPC round trip, or a War Room tick in
  // between sees a clean pane and pastes onto it. Order matters: IME baseline
  // first, then dirty. A failed write leaves a dirty flag without text, which
  // only holds room deliveries until the next Enter — harmless.
  deps.resetInput(req.terminalId)
  const stamp = deps.markDraft(req.terminalId, deps.now())
  try {
    await deps.write(req.terminalId, req.expectedSpawnId, prepareDictationBody(req.text, bracketed))
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }

  const wantSubmit = req.submit && bracketed
  if (wantSubmit) void submitLater(req, deps, stamp)
  return { ok: true, submitScheduled: wantSubmit }
}

async function submitLater(req: DictationRequest, deps: DictationDeps, stamp: number): Promise<void> {
  await deps.sleep(deps.submitDelayMs)
  const go = shouldSubmitDictation({
    requested: req.submit,
    allowAutoEnter: true,
    bracketed: deps.draftInfo(req.terminalId)?.bracketed ?? false,
    agentState: deps.agentState(req.terminalId),
    // The checked write below is the generation check; a respawn rejects it.
    sameGeneration: true,
    inputStampAtInsert: stamp,
    inputStampNow: deps.inputStamp(req.terminalId)
  })
  if (!go) return
  // A failed Enter leaves the draft standing, which is the safe outcome.
  await deps.write(req.terminalId, req.expectedSpawnId, '\r').catch(() => undefined)
}

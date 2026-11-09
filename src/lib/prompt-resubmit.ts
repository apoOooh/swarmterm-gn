import type { AgentEngineState } from '@/lib/agent-state/types'
import { prepareDictationBody, shouldSubmitDictation } from '@/lib/voice-insert'

/**
 * SWA-88: data-shield's guard blocked a prompt and Rust accepted its masked
 * form (`POST /resubmit` → `prompt:resubmit`). Claude Code puts the BLOCKED
 * plaintext back into its input box once its hooks finish, so the order is:
 * wait for that draft, clear it with Esc Esc (measured: clears one- and
 * multi-line drafts, no Ctrl+C — that would count as an interrupt), verify
 * the box is empty, insert the masked text and, in "send" mode, press Enter
 * as a separate delayed write (same rules as a dictation).
 *
 * Anything the user did since their Enter wins: a key in this pane means
 * the box may hold their text, so nothing is cleared or written and the pill
 * offers the masked text to copy instead. Esc Esc is pressed only on a box
 * that visibly holds a draft — on an empty box it can open Claude's rewind
 * menu.
 */

export type ResubmitMode = 'send' | 'insert' | 'off'

export interface ResubmitRequest {
  terminalId: string
  spawnId: string
  text: string
  /** Rust's verdict (setting AND admin lock); the local setting may lower it. */
  send: boolean
}

export type ResubmitFallback = 'typed' | 'target-busy' | 'not-cleared' | 'write-failed'

export type ResubmitOutcome =
  | { kind: 'inserted'; submitScheduled: boolean }
  /** Not written: the pill offers the masked text for copying. */
  | { kind: 'fallback'; reason: ResubmitFallback }
  /** Nothing to do (switched off, or the pane is gone). */
  | { kind: 'dropped'; reason: 'off' | 'target-gone' }

export interface ResubmitDeps {
  mode: () => ResubmitMode
  draftInfo: (id: string) => { bracketed: boolean; composing: boolean } | undefined
  agentState: (id: string) => AgentEngineState | undefined
  /** Claude's input box shows unsent text (dim placeholder excluded). */
  boxHasDraft: (id: string) => boolean
  /** Typing-store `lastKeyAt`: cleared by the user's Enter, set by any key since. */
  inputStamp: (id: string) => number | undefined
  write: (id: string, expectedSpawnId: string, data: string) => Promise<void>
  resetInput: (id: string) => void
  markDraft: (id: string, nowMs: number) => number
  now: () => number
  sleep: (ms: number) => Promise<void>
  submitDelayMs: number
}

/** How long Claude may take to finish its hooks and restore the draft. */
export const DRAFT_WAIT_MS = 3000
/** Settle time after Esc Esc before the box is read again. */
export const CLEAR_SETTLE_MS = 600
const POLL_MS = 100
const ESC_GAP_MS = 150

function typedSince(deps: ResubmitDeps, id: string): boolean {
  return deps.inputStamp(id) !== undefined
}

function reasonOf(e: unknown): 'target-gone' | 'write-failed' {
  const text = e instanceof Error ? e.message : String(e)
  return text.startsWith('target-gone') ? 'target-gone' : 'write-failed'
}

export async function deliverResubmit(req: ResubmitRequest, deps: ResubmitDeps): Promise<ResubmitOutcome> {
  const mode = deps.mode()
  if (mode === 'off') return { kind: 'dropped', reason: 'off' }
  const id = req.terminalId
  if (!deps.draftInfo(id)) return { kind: 'dropped', reason: 'target-gone' }

  // The guard posts before it exits; Claude restores the blocked text after.
  let draft = deps.boxHasDraft(id)
  for (let waited = 0; !draft && waited < DRAFT_WAIT_MS; waited += POLL_MS) {
    if (typedSince(deps, id)) return { kind: 'fallback', reason: 'typed' }
    await deps.sleep(POLL_MS)
    if (!deps.draftInfo(id)) return { kind: 'dropped', reason: 'target-gone' }
    draft = deps.boxHasDraft(id)
  }
  if (typedSince(deps, id)) return { kind: 'fallback', reason: 'typed' }
  if (deps.agentState(id) === 'blocked') return { kind: 'fallback', reason: 'target-busy' }

  try {
    if (draft) {
      for (let i = 0; i < 2; i++) {
        await deps.write(id, req.spawnId, '\x1b')
        await deps.sleep(ESC_GAP_MS)
      }
      await deps.sleep(CLEAR_SETTLE_MS)
      if (deps.boxHasDraft(id)) return { kind: 'fallback', reason: 'not-cleared' }
      if (typedSince(deps, id)) return { kind: 'fallback', reason: 'typed' }
    }
    const info = deps.draftInfo(id)
    if (!info) return { kind: 'dropped', reason: 'target-gone' }
    if (info.composing) return { kind: 'fallback', reason: 'typed' }
    // Same order as a dictation: IME baseline, then dirty, then the write.
    deps.resetInput(id)
    const stamp = deps.markDraft(id, deps.now())
    await deps.write(id, req.spawnId, prepareDictationBody(req.text, info.bracketed))
    const wantSubmit = req.send && mode === 'send' && info.bracketed
    if (wantSubmit) void submitLater(req, deps, stamp)
    return { kind: 'inserted', submitScheduled: wantSubmit }
  } catch (e) {
    const reason = reasonOf(e)
    return reason === 'target-gone' ? { kind: 'dropped', reason } : { kind: 'fallback', reason }
  }
}

async function submitLater(req: ResubmitRequest, deps: ResubmitDeps, stamp: number): Promise<void> {
  await deps.sleep(deps.submitDelayMs)
  const go = shouldSubmitDictation({
    requested: true,
    allowAutoEnter: deps.mode() === 'send',
    bracketed: deps.draftInfo(req.terminalId)?.bracketed ?? false,
    agentState: deps.agentState(req.terminalId),
    sameGeneration: true,
    inputStampAtInsert: stamp,
    inputStampNow: deps.inputStamp(req.terminalId)
  })
  if (!go) return
  // A failed Enter leaves the masked draft standing: the user sends it.
  await deps.write(req.terminalId, req.spawnId, '\r').catch(() => undefined)
}

/** Settings value, validated field-wise like the rest of the agent policy. */
export function parseResubmitMode(raw: unknown): ResubmitMode {
  return raw === 'insert' || raw === 'off' ? raw : 'send'
}

/** The stricter of the user's choice and the admin locks. */
export function effectiveResubmitMode(
  user: ResubmitMode,
  locks: { disablePromptResubmit?: boolean; disablePromptResubmitSend?: boolean }
): ResubmitMode {
  if (locks.disablePromptResubmit || user === 'off') return 'off'
  if (locks.disablePromptResubmitSend || user === 'insert') return 'insert'
  return 'send'
}

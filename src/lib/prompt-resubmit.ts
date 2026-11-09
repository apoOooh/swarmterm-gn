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
 * Hardening, not a trust boundary (`docs/security-model.md`). Everything
 * Rust checks can be faked by a process in the pane (bearer, edge,
 * fingerprint), and so can what the screen shows. What such a process
 * cannot do is press a key in this renderer. So:
 *
 * 1. The anchor: the user really sent a line in this pane
 *    (`takeUserSubmit`: a plain Enter KEY whose CR reached `sendInput` —
 *    not LF/Shift+Enter/Ctrl+J, not a paste, not an xterm reply — at most
 *    `USER_SUBMIT_MAX_AGE_MS` before the event, consumed once — one
 *    resubmit per real submit and generation). It carries the pane's input
 *    revision at that Enter.
 * 2. A non-empty draft is visible in Claude's box right before the first
 *    Esc. Where it reads back unambiguously (`draftText`: one row, no DIM
 *    cell, not at the row's edge) it must also match the `asked`
 *    fingerprint, else fallback. A draft that cannot be read back exactly
 *    (several rows, wrapped, "[Pasted text …]") is not compared: the
 *    user's Enter plus the visible draft carry it (user decision
 *    2026-11-09).
 * 3. At most one attempt with Enter per pane per `AUTO_SEND_WINDOW_MS`,
 *    failed ones included; a further one is inserted without Enter and the
 *    caller rings the bell.
 * 4. Before EVERY step and after every await — each Esc, during the
 *    settle, the insert, the Enter — the input revision must still be the
 *    anchor's (any key since: Esc, Ctrl+C, the clear shortcut, a new
 *    Enter; a clear moves it on too, never back), no IME composition, the
 *    agent not `blocked`, the mode on and the pane alive. Anything else
 *    stops the sequence at once, with no further write.
 *
 * Every fallback offers the masked text in the pane's pill for copying.
 */

export type ResubmitMode = 'send' | 'insert' | 'off'

/** Length (UTF-8 bytes) + SHA-256 hex of the blocked prompt, as Rust matched it. */
export interface PromptFingerprint {
  len: number
  sha256: string
}

export interface ResubmitRequest {
  terminalId: string
  spawnId: string
  text: string
  /** Rust's verdict (setting AND admin lock); the local setting may lower it. */
  send: boolean
  asked: PromptFingerprint
}

export type ResubmitFallback =
  | 'typed'
  | 'target-busy'
  | 'not-cleared'
  | 'no-draft'
  | 'no-user-submit'
  | 'unverified'
  | 'write-failed'

export type ResubmitOutcome =
  /** `rateLimited`: Enter was wanted but this pane used its auto-send budget. */
  | { kind: 'inserted'; submitScheduled: boolean; rateLimited?: boolean }
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
  /** The box's draft as exact text, `undefined` when not readable without guessing. */
  draftText: (id: string) => string | undefined
  /** Typing-store `inputRev`: moved on by every real input and every clear. */
  inputRevision: (id: string) => number | undefined
  /** Typing-store `lastKeyAt`: cleared by the user's Enter, set by any key since. */
  inputStamp: (id: string) => number | undefined
  /** Typing-store `dirty`: an unsubmitted line the user typed. */
  inputDirty: (id: string) => boolean
  /** Consumes the user's last real submit if it is recent enough (typing
   *  store): the input revision at that Enter, undefined when there is none. */
  takeUserSubmit: (id: string, nowMs: number, maxAgeMs: number) => number | undefined
  /** Claims the pane's automatic-Enter budget (`createAutoSendLimiter`). */
  claimAutoSend: (id: string, nowMs: number) => boolean
  /** Hex SHA-256 of the UTF-8 bytes. */
  sha256: (text: string) => Promise<string>
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
/**
 * The user's Enter may be this old when the block arrives. The guard
 * answers within ~1–5 s of the edge, its first prompt in a session and a
 * busy machine take longer; older means the resubmit belongs to no prompt
 * the user just sent (user decision 2026-11-09: 15 s).
 */
export const USER_SUBMIT_MAX_AGE_MS = 15_000
/** At most one attempt with Enter per pane in this window. */
export const AUTO_SEND_WINDOW_MS = 30_000
const POLL_MS = 100
const ESC_GAP_MS = 150

/** Thrown inside the sequence to stop it; turned into the outcome below. */
class Stop {
  constructor(readonly outcome: ResubmitOutcome) {}
}

const fallback = (reason: ResubmitFallback): Stop => new Stop({ kind: 'fallback', reason })

/**
 * Per-pane budget for attempts with Enter: true claims it. Claimed when the
 * event arrives, before anything is checked, so a failed or refused attempt
 * uses the slot too — and a new session or prompt id cannot reset it.
 */
export function createAutoSendLimiter(windowMs = AUTO_SEND_WINDOW_MS): (id: string, nowMs: number) => boolean {
  const last = new Map<string, number>()
  return (id, nowMs) => {
    const prev = last.get(id)
    if (prev !== undefined && nowMs - prev < windowMs) return false
    last.set(id, nowMs)
    return true
  }
}

/** Exact match of a text against the fingerprint (length first, then hash). */
export async function matchesFingerprint(
  text: string,
  asked: PromptFingerprint,
  sha256: (text: string) => Promise<string>
): Promise<boolean> {
  if (new TextEncoder().encode(text).length !== asked.len) return false
  return (await sha256(text)) === asked.sha256
}

function reasonOf(e: unknown): 'target-gone' | 'write-failed' {
  const text = e instanceof Error ? e.message : String(e)
  return text.startsWith('target-gone') ? 'target-gone' : 'write-failed'
}

export async function deliverResubmit(req: ResubmitRequest, deps: ResubmitDeps): Promise<ResubmitOutcome> {
  const id = req.terminalId
  if (deps.mode() === 'off') return { kind: 'dropped', reason: 'off' }
  if (!deps.draftInfo(id)) return { kind: 'dropped', reason: 'target-gone' }
  const arrived = deps.now()
  // Consumed first, whatever happens next: one resubmit per real submit.
  const anchorRev = deps.takeUserSubmit(id, arrived, USER_SUBMIT_MAX_AGE_MS)
  if (anchorRev === undefined) return { kind: 'fallback', reason: 'no-user-submit' }
  const mayEnter = deps.claimAutoSend(id, arrived)

  /** Before every step and after every await: the user, the agent, the policy and the pane. */
  const guard = (): void => stillOurs(req, deps, anchorRev)

  try {
    // The guard posts before it exits; Claude restores the blocked text after.
    let draft = deps.boxHasDraft(id)
    for (let waited = 0; !draft && waited < DRAFT_WAIT_MS; waited += POLL_MS) {
      guard()
      await deps.sleep(POLL_MS)
      draft = deps.boxHasDraft(id)
    }
    guard()
    if (!draft) throw fallback('no-draft')

    // Where the restored draft reads back exactly, it must BE the blocked
    // prompt. Unreadable (multi-row, wrapped, collapsed paste) is not a
    // verdict: the Enter binding and the visible draft carry it.
    const restored = deps.draftText(id)
    if (restored !== undefined && !(await matchesFingerprint(restored, req.asked, deps.sha256))) {
      throw fallback('unverified')
    }
    guard()

    for (let i = 0; i < 2; i++) {
      // Re-checked before EACH Esc: a key between them means the box may
      // now hold the user's own text, and another Esc would erase it.
      guard()
      // Read right before the Esc: on an empty box Esc opens Claude's
      // rewind menu (and the first Esc may already have cleared it).
      if (!deps.boxHasDraft(id)) {
        if (i === 0) throw fallback('no-draft')
        break
      }
      await deps.write(id, req.spawnId, '\x1b')
      guard()
      await deps.sleep(ESC_GAP_MS)
    }
    for (let settled = 0; settled < CLEAR_SETTLE_MS; settled += POLL_MS) {
      guard()
      await deps.sleep(POLL_MS)
    }
    guard()
    if (deps.boxHasDraft(id)) throw fallback('not-cleared')
    const info = deps.draftInfo(id)
    if (!info) throw new Stop({ kind: 'dropped', reason: 'target-gone' })
    // Nothing awaits between this guard and the write: no key slips in.
    // Same order as a dictation: IME baseline, then dirty, then the write.
    deps.resetInput(id)
    const stamp = deps.markDraft(id, deps.now())
    await deps.write(id, req.spawnId, prepareDictationBody(req.text, info.bracketed))
    const wanted = req.send && deps.mode() === 'send' && info.bracketed
    const wantSubmit = wanted && mayEnter
    if (wantSubmit) void submitLater(req, deps, stamp, anchorRev)
    return wanted && !wantSubmit
      ? { kind: 'inserted', submitScheduled: false, rateLimited: true }
      : { kind: 'inserted', submitScheduled: wantSubmit }
  } catch (e) {
    if (e instanceof Stop) return e.outcome
    const reason = reasonOf(e)
    return reason === 'target-gone' ? { kind: 'dropped', reason } : { kind: 'fallback', reason }
  }
}

/**
 * Throws a `Stop` unless the attempt still belongs to the user's Enter:
 * mode on, pane alive, no input since the anchor (revision, plus the older
 * typing signals as a second net), no IME composition, agent not `blocked`
 * (a permission prompt reads Esc and pasted text as answers).
 */
function stillOurs(req: ResubmitRequest, deps: ResubmitDeps, anchorRev: number): void {
  const id = req.terminalId
  if (deps.mode() === 'off') throw new Stop({ kind: 'dropped', reason: 'off' })
  const info = deps.draftInfo(id)
  if (!info) throw new Stop({ kind: 'dropped', reason: 'target-gone' })
  if (deps.inputRevision(id) !== anchorRev || info.composing) throw fallback('typed')
  if (deps.inputStamp(id) !== undefined || deps.inputDirty(id)) throw fallback('typed')
  if (deps.agentState(id) === 'blocked') throw fallback('target-busy')
}

async function submitLater(req: ResubmitRequest, deps: ResubmitDeps, stamp: number, anchorRev: number): Promise<void> {
  await deps.sleep(deps.submitDelayMs)
  // The revision outlives our own markDraft (which leaves it alone), so any
  // key, clear or new Enter since the anchor still stops the Enter here.
  if (deps.inputRevision(req.terminalId) !== anchorRev) return
  const info = deps.draftInfo(req.terminalId)
  const go = shouldSubmitDictation({
    requested: true,
    allowAutoEnter: deps.mode() === 'send',
    bracketed: info?.bracketed ?? false,
    agentState: deps.agentState(req.terminalId),
    sameGeneration: true,
    inputStampAtInsert: stamp,
    inputStampNow: deps.inputStamp(req.terminalId)
  })
  // The box must still show the inserted text (our own markDraft stamp is
  // what `go` compares; the screen check catches a cleared box).
  if (!go || info?.composing || !deps.boxHasDraft(req.terminalId)) return
  // A failed Enter leaves the masked draft standing: the user sends it.
  // The spawn id check in `write` keeps it off a respawned generation.
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

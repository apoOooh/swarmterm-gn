/**
 * Account/agent handoff (SWA-22): pure state machine behind the Handoff
 * dialog. A handoff opens a NEW pane (the old one stays untouched) and types
 * the SWA-21 brief into it as the first prompt — but only after three gates:
 *
 * 1. the new pane's pty reported `running` AND the target CLI itself
 *    announced its session through the `agent:session` hook for this pane's
 *    current pty generation (a failed spawn, a missing CLI or a CLI that fell
 *    back to the shell never gets text — the screen detector's `idle` is
 *    NOT proof: it is also its fallback for an unrecognised screen),
 * 2. the pty generation captured at that moment is still the live one when
 *    the user confirms (a respawn in between means a different process —
 *    typing into it would hand the brief to something the user never saw),
 * 3. the user pressed Send.
 *
 * Delivery itself is one shot. `failed` and `delivered` are terminal: there is
 * no automatic retry, because the body write may already have reached the
 * pty and a second attempt would paste the brief twice. The user can copy the
 * brief by hand instead. The typing hold (war-room-nudge) only delays the
 * single attempt; it never repeats it.
 */
import type { AgentAccount } from '@/tauri/accounts'
import type { HoldReason } from '@/lib/war-room-nudge'
import type { AgentEngineState } from '@/lib/agent-state/types'
import { templateById } from '@/lib/templates'

/** `gone` = the new pane was closed (no registry entry, no layout leaf). */
export type PtyKind = 'connecting' | 'running' | 'exited' | 'error' | 'gone'

export interface LivePty {
  kind: PtyKind
  generation: number | undefined
  /** Agent-state engine verdict for the pane. A running pty only proves the
   *  SHELL started; the target CLI may be missing or may have died back to the
   *  prompt. `unknown`/absent = no agent detected = plain shell. */
  agent: AgentEngineState | undefined
}

/** Agent detected in the pane (any engine verdict other than "no agent"). */
const agentAlive = (agent: AgentEngineState | undefined): boolean => agent !== undefined && agent !== 'unknown'

export type HandoffPhase = 'choosing' | 'starting' | 'ready' | 'delivering' | 'delivered' | 'pasted' | 'failed' | 'cancelled'

export interface HandoffState {
  phase: HandoffPhase
  terminalId?: string
  /** CLI the new pane was started with; only its own session hook counts. */
  agentId?: string
  /** Pty generation live when that CLI's `agent:session` hook arrived. */
  sessionGeneration?: number
  /** Pty generation observed when the new pane became ready. */
  generation?: number
  /** The detector has recognised the agent at least once since ready. Until
   *  then `unknown` is its startup grace (the session hook can beat it), not
   *  a dead agent; Send waits for it. */
  agentSeen?: boolean
  held?: HoldReason
  deliveredAt?: number
  error?: string
}

export type HandoffEvent =
  | { type: 'spawned'; terminalId: string; agentId: string }
  /** `agent:session` hook (Rust already matched it to the pane's spawn and
   *  agent); `generation` is the renderer's pty generation at arrival. */
  | { type: 'session'; terminalId: string; agentId: string; generation: number | undefined }
  | { type: 'status'; kind: PtyKind; generation: number | undefined; agent?: AgentEngineState; message?: string }
  | { type: 'confirm'; live: LivePty }
  | { type: 'held'; reason: HoldReason }
  | { type: 'delivered'; at: number }
  /** Body pasted but Enter withheld: something changed in the submit window. */
  | { type: 'pasted'; reason: string }
  | { type: 'failed'; error: string }
  | { type: 'cancel' }

export function initialHandoff(): HandoffState {
  return { phase: 'choosing' }
}

const fail = (s: HandoffState, error: string): HandoffState => ({ ...s, phase: 'failed', held: undefined, error })

/** Returns the SAME object when the event does not apply, so callers can detect no-ops. */
export function reduceHandoff(s: HandoffState, e: HandoffEvent): HandoffState {
  if (s.phase === 'delivered' || s.phase === 'pasted' || s.phase === 'failed' || s.phase === 'cancelled') return s
  switch (e.type) {
    case 'spawned':
      return s.phase === 'choosing' ? { phase: 'starting', terminalId: e.terminalId, agentId: e.agentId } : s
    case 'session':
      if (s.phase !== 'starting' || e.terminalId !== s.terminalId || e.agentId !== s.agentId || e.generation === undefined) return s
      return { ...s, sessionGeneration: e.generation }
    case 'status':
      if (s.phase === 'choosing') return s
      if (e.kind === 'error') return fail(s, e.message ?? 'The new pane failed to start.')
      if (e.kind === 'exited') return fail(s, 'The new pane exited before the brief was delivered.')
      if (e.kind === 'gone') return fail(s, 'The new pane was closed before the brief was delivered.')
      // Ready only on a positive, agent-specific signal: the CLI's own session
      // hook for THIS pty generation. A shell whose CLI is missing or crashed
      // is `running` too, and the detector reports `idle` for screens it
      // does not recognise — either would run the brief's lines as commands.
      if (s.phase === 'starting') {
        const proven = e.kind === 'running' && s.sessionGeneration !== undefined && e.generation === s.sessionGeneration
        return proven ? { ...s, phase: 'ready', generation: e.generation, agentSeen: agentAlive(e.agent) } : s
      }
      if (e.generation !== s.generation) return fail(s, 'The new pane restarted; the brief was not sent.')
      if (agentAlive(e.agent)) return s.agentSeen ? s : { ...s, agentSeen: true }
      // Only a loss AFTER the detector settled on the agent is a death.
      if (s.agentSeen) return fail(s, 'The agent in the new pane is not running; a plain shell never receives the brief.')
      return s
    case 'confirm':
      if (s.phase !== 'ready' || !s.agentSeen) return s
      if (e.live.kind !== 'running') return fail(s, 'The new pane is no longer running.')
      if (e.live.generation !== s.generation) return fail(s, 'The new pane restarted; the brief was not sent.')
      if (!agentAlive(e.live.agent)) return fail(s, 'The agent in the new pane is not running; a plain shell never receives the brief.')
      return { ...s, phase: 'delivering' }
    case 'held':
      return s.phase === 'delivering' ? { ...s, held: e.reason } : s
    case 'delivered':
      return s.phase === 'delivering' ? { ...s, phase: 'delivered', held: undefined, deliveredAt: e.at } : s
    case 'pasted':
      return s.phase === 'delivering' ? { ...s, phase: 'pasted', held: undefined, error: e.reason } : s
    case 'failed':
      return s.phase === 'choosing' ? s : fail(s, e.error)
    case 'cancel':
      return s.phase === 'delivering' ? s : { ...s, phase: 'cancelled' }
  }
}

export interface HandoffTarget {
  agentId: AgentAccount['agentId']
  accountId?: string
  label: string
}

/** Default configuration first, then saved profiles (SWA-9), per CLI. With
 *  `available` (ids the backend probe found), CLIs not installed are hidden —
 *  starting them would leave a plain shell. CLIs in `noSessionHooks` are
 *  hidden too: readiness is proven only by the CLI's session hook, so such a
 *  pane would wait in "starting" forever (see `sessionHookGaps`). */
export function handoffTargets(
  accounts: readonly AgentAccount[],
  available?: ReadonlySet<string>,
  noSessionHooks?: ReadonlySet<string>
): HandoffTarget[] {
  return (['claude-code', 'codex'] as const)
    .filter((id) => (!available || available.has(id)) && !noSessionHooks?.has(id))
    .flatMap((agentId) => {
    const name = templateById(agentId).name
    return [
      { agentId, label: `${name} · Default` },
      ...accounts.filter((a) => a.agentId === agentId).map((a) => ({ agentId, accountId: a.id, label: `${name} · ${a.name}` }))
    ]
  })
}

/** Installed CLIs that cannot report their session to Swarmterm. Claude Code
 *  hooks are always written; Codex only when the probe confirms hook support
 *  (older Codex builds lack it). */
export function sessionHookGaps(entries: readonly { id: string; available: boolean; sessionHooks?: boolean }[]): Set<string> {
  return new Set(entries.filter((e) => e.available && e.id === 'codex' && e.sessionHooks !== true).map((e) => e.id))
}

const LIMIT_PATTERN = /(usage limit|rate limit|limit reached|out of (?:credits|usage)|try again (?:at|in))/i

/**
 * Terminal text is unreliable (truncated, redrawn), so a limit message is
 * shown as a hint only — it never counts as usage data and never decides
 * anything.
 */
export function limitHint(terminalText: string): string | undefined {
  return LIMIT_PATTERN.test(terminalText) ? 'Hint: the source pane output mentions a usage limit (not verified).' : undefined
}

export interface SubmitSnapshot {
  running: boolean
  generation: number | undefined
  expectedGeneration: number | undefined
  hold: HoldReason | null
  agent: AgentEngineState | undefined
}

/**
 * Re-check right before the delayed Enter. Anything that changed since the
 * body was pasted — user typing, a permission prompt, a restart, the agent
 * gone — means Enter would submit something else (or approve a prompt), so it
 * is withheld. Returns the reason, or null when Enter is safe.
 */
export function submitBlocker(s: SubmitSnapshot): string | null {
  if (!s.running || s.generation !== s.expectedGeneration) return 'the new pane stopped or restarted'
  if (!agentAlive(s.agent)) return 'the agent in the new pane is no longer running'
  if (s.hold === 'typing') return 'you typed in the new pane'
  if (s.hold === 'agent-blocked') return 'the agent is showing a permission or question prompt'
  if (s.hold === 'agent-working') return 'the agent started working'
  return null
}

/** Focus trap: index to move focus to on Tab, or null to let the browser move it. */
export function focusTrapTarget(count: number, current: number, shift: boolean): number | null {
  if (count === 0) return null
  if (current < 0) return shift ? count - 1 : 0
  if (shift && current === 0) return count - 1
  if (!shift && current === count - 1) return 0
  return null
}

/** How long "Starting…" may last before the dialog points the user at the pane. */
export const STARTING_HINT_MS = 15_000

/**
 * A CLI waiting on a trust/login prompt never reports its session, so the
 * handoff stays in `starting`. After a while the dialog says so — it never
 * sends on its own; the user answers the prompt in the pane.
 */
export function startingHint(phase: HandoffPhase, startedAt: number | undefined, now: number): string | undefined {
  if (phase !== 'starting' || startedAt === undefined || now - startedAt < STARTING_HINT_MS) return undefined
  return 'Agent not ready yet — answer its prompt (trust, login) in the new pane. The handoff waits here.'
}

/** How long a ready pane may stay unrecognised by the detector before the dialog explains the locked Send. */
export const READY_HINT_MS = 15_000

/**
 * The session hook proved the CLI started, but Send waits for the detector to
 * recognise the agent. A screen it never recognises would otherwise leave a
 * silently disabled button.
 */
export function readyHint(phase: HandoffPhase, agentSeen: boolean | undefined, readyAt: number | undefined, now: number): string | undefined {
  if (phase !== 'ready' || agentSeen || readyAt === undefined || now - readyAt < READY_HINT_MS) return undefined
  return 'The agent reported its session but is not recognised on screen yet, so Send stays locked. Check the new pane, or copy the brief from the Handoff brief dialog.'
}

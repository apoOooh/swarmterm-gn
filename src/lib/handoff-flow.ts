/**
 * Account/agent handoff (SWA-22): pure state machine behind the Handoff
 * dialog. A handoff opens a NEW pane (the old one stays untouched) and types
 * the SWA-21 brief into it as the first prompt — but only after three gates:
 *
 * 1. the new pane's pty reported `running` (a failed spawn never gets text),
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
import { templateById } from '@/lib/templates'

export type PtyKind = 'connecting' | 'running' | 'exited' | 'error'

export interface LivePty {
  kind: PtyKind
  generation: number | undefined
}

export type HandoffPhase = 'choosing' | 'starting' | 'ready' | 'delivering' | 'delivered' | 'failed' | 'cancelled'

export interface HandoffState {
  phase: HandoffPhase
  terminalId?: string
  /** Pty generation observed when the new pane first ran. */
  generation?: number
  held?: HoldReason
  deliveredAt?: number
  error?: string
}

export type HandoffEvent =
  | { type: 'spawned'; terminalId: string }
  | { type: 'status'; kind: PtyKind; generation: number | undefined; message?: string }
  | { type: 'confirm'; live: LivePty }
  | { type: 'held'; reason: HoldReason }
  | { type: 'delivered'; at: number }
  | { type: 'failed'; error: string }
  | { type: 'cancel' }

export function initialHandoff(): HandoffState {
  return { phase: 'choosing' }
}

const fail = (s: HandoffState, error: string): HandoffState => ({ ...s, phase: 'failed', held: undefined, error })

/** Returns the SAME object when the event does not apply, so callers can detect no-ops. */
export function reduceHandoff(s: HandoffState, e: HandoffEvent): HandoffState {
  if (s.phase === 'delivered' || s.phase === 'failed' || s.phase === 'cancelled') return s
  switch (e.type) {
    case 'spawned':
      return s.phase === 'choosing' ? { phase: 'starting', terminalId: e.terminalId } : s
    case 'status':
      if (s.phase === 'choosing') return s
      if (e.kind === 'error') return fail(s, e.message ?? 'The new pane failed to start.')
      if (e.kind === 'exited') return fail(s, 'The new pane exited before the brief was delivered.')
      if (s.phase === 'starting' && e.kind === 'running') return { ...s, phase: 'ready', generation: e.generation }
      if ((s.phase === 'ready' || s.phase === 'delivering') && e.generation !== s.generation) {
        return fail(s, 'The new pane restarted; the brief was not sent.')
      }
      return s
    case 'confirm':
      if (s.phase !== 'ready') return s
      if (e.live.kind !== 'running') return fail(s, 'The new pane is no longer running.')
      if (e.live.generation !== s.generation) return fail(s, 'The new pane restarted; the brief was not sent.')
      return { ...s, phase: 'delivering' }
    case 'held':
      return s.phase === 'delivering' ? { ...s, held: e.reason } : s
    case 'delivered':
      return s.phase === 'delivering' ? { ...s, phase: 'delivered', held: undefined, deliveredAt: e.at } : s
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

/** Default configuration first, then saved profiles (SWA-9), per CLI. */
export function handoffTargets(accounts: readonly AgentAccount[]): HandoffTarget[] {
  return (['claude-code', 'codex'] as const).flatMap((agentId) => {
    const name = templateById(agentId).name
    return [
      { agentId, label: `${name} · Default` },
      ...accounts.filter((a) => a.agentId === agentId).map((a) => ({ agentId, accountId: a.id, label: `${name} · ${a.name}` }))
    ]
  })
}

/** A usage reading taken from structured CLI output (JSON/status payload) — never scraped text. */
export interface UsageSample {
  usedPercent: number
  source: string
  at: number
}

export interface UsageView {
  known: boolean
  text: string
  checkedAt: number
}

export function describeUsage(sample: UsageSample | undefined, now: number): UsageView {
  if (!sample || !Number.isFinite(sample.usedPercent) || sample.usedPercent < 0 || sample.usedPercent > 100) {
    return { known: false, text: 'Usage unknown', checkedAt: now }
  }
  return { known: true, text: `Usage ${Math.round(sample.usedPercent)}% (${sample.source})`, checkedAt: sample.at }
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

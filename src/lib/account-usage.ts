/**
 * Subscription usage per account profile (SWA-37).
 *
 * The only structured source is Claude Code's status-line payload
 * (`rate_limits.five_hour` / `seven_day`), relayed by Rust as `agent:usage`
 * (`src-tauri/src/mcp/rate_limits.rs`). Usage belongs to the ACCOUNT, not to
 * the pane, so samples are keyed by the pane's account profile: any Claude pane
 * on that profile refreshes it, and the handoff can show the target account's
 * number even when no pane of it is open right now (with its age). Codex has
 * no structured source, so it never gets a sample — "unknown" is the truth.
 */

export interface UsageWindow {
  pct: number
  /** Epoch seconds; absent when Claude Code did not report it. */
  resetsAt?: number | null
}

export interface AccountUsage {
  fiveHour?: UsageWindow | null
  sevenDay?: UsageWindow | null
  /** When the sample was taken (ms). */
  at: number
}

/** Store key for an account profile; `undefined` = the agent's default profile. */
export function accountUsageKey(agentId: string, accountId: string | undefined): string {
  return `${agentId}:${accountId ?? ''}`
}

function validWindow(w: UsageWindow | null | undefined): UsageWindow | undefined {
  return w && Number.isFinite(w.pct) && w.pct >= 0 && w.pct <= 100 ? w : undefined
}

/** Fold an event into the stored sample. A sample without any valid window is ignored. */
export function applyUsageSample(prev: AccountUsage | undefined, next: AccountUsage): AccountUsage | undefined {
  const fiveHour = validWindow(next.fiveHour)
  const sevenDay = validWindow(next.sevenDay)
  if (!fiveHour && !sevenDay) return prev
  if (prev && prev.at > next.at) return prev
  return { fiveHour, sevenDay, at: next.at }
}

export interface UsageView {
  known: boolean
  text: string
  checkedAt: number
}

function resetText(resetsAt: number | null | undefined): string {
  if (!resetsAt) return ''
  return `, resets ${new Date(resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function describeUsage(sample: AccountUsage | undefined, now: number): UsageView {
  const five = validWindow(sample?.fiveHour)
  const seven = validWindow(sample?.sevenDay)
  if (!sample || (!five && !seven)) return { known: false, text: 'Usage unknown', checkedAt: now }
  const parts: string[] = []
  if (five) parts.push(`5h ${Math.round(five.pct)}%${resetText(five.resetsAt)}`)
  if (seven) parts.push(`7d ${Math.round(seven.pct)}%`)
  return { known: true, text: `Usage ${parts.join(' · ')} (Claude Code status line)`, checkedAt: sample.at }
}

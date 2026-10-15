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

/**
 * A window whose reset has passed says nothing about the account any more —
 * the real number restarted near 0 — so it is dropped rather than shown stale.
 * `nowMs` is wall-clock ms; `resetsAt` is epoch seconds.
 */
export function dropExpiredWindows(sample: AccountUsage, nowMs: number): AccountUsage | undefined {
  const live = (w: UsageWindow | null | undefined): UsageWindow | undefined => {
    const v = validWindow(w)
    return v && (!v.resetsAt || v.resetsAt * 1000 > nowMs) ? v : undefined
  }
  const fiveHour = live(sample.fiveHour)
  const sevenDay = live(sample.sevenDay)
  return fiveHour || sevenDay ? { fiveHour, sevenDay, at: sample.at } : undefined
}

export const USAGE_STORAGE_KEY = 'swarmterm.accountUsage'

/**
 * Last samples survive a restart: Claude only reports usage while one of its
 * panes renders the status line, so without this every launch starts at `—`.
 * Only the numbers are stored — no account names or folders.
 */
export function readStoredUsage(storage: Storage, nowMs: number): Record<string, AccountUsage> {
  let raw: unknown
  try { raw = JSON.parse(storage.getItem(USAGE_STORAGE_KEY) ?? '{}') } catch { return {} }
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, AccountUsage> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const s = value as AccountUsage | null
    if (!s || typeof s !== 'object' || !Number.isFinite(s.at)) continue
    const live = dropExpiredWindows(s, nowMs)
    if (live) out[key] = live
  }
  return out
}

export function storeUsage(storage: Storage, byAccount: Record<string, AccountUsage>): void {
  try { storage.setItem(USAGE_STORAGE_KEY, JSON.stringify(byAccount)) } catch { /* quota/private mode: memory only */ }
}

const FRESH_MS = 5 * 60_000

/** Short age label for a sample, `undefined` while it is still fresh. */
export function usageAge(atMs: number, nowMs: number): string | undefined {
  const min = Math.floor((nowMs - atMs) / 60_000)
  if (nowMs - atMs < FRESH_MS) return undefined
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

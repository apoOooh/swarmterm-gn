/**
 * Presentation rules for the Accounts panel: plan names, the status light and
 * remaining budget. The data comes from `get_account_status` (Rust reads the
 * CLIs' own files) and, for Claude, from the status line's `agent:usage`.
 */
import type { UsageWindow } from './account-usage'

export type LoginState = 'connected' | 'expired' | 'loggedOut'
export type LampColor = 'green' | 'yellow' | 'red' | 'grey'

const PLAN_NAMES: Record<string, string> = {
  max: 'Max', pro: 'Pro', plus: 'Plus', team: 'Team', enterprise: 'Enterprise', free: 'Free', business: 'Business', edu: 'Edu'
}

export function planLabel(plan: string | null | undefined): string | undefined {
  if (!plan) return undefined
  const known = PLAN_NAMES[plan.toLowerCase()]
  if (known) return known
  if (/[A-Z ]/.test(plan)) return plan
  const words = plan.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function statusLamp(status: { state: LoginState } | undefined): { color: LampColor; label: string } {
  if (!status) return { color: 'grey', label: 'Not checked yet' }
  switch (status.state) {
    case 'connected': return { color: 'green', label: 'Connected' }
    // The CLI can no longer refresh on its own; a new login fixes it.
    case 'expired': return { color: 'yellow', label: 'Login expired — log in again' }
    case 'loggedOut': return { color: 'red', label: 'Not logged in' }
  }
}

/** Percent of the window used — the status line's reading; `undefined` when unknown. */
export function budgetUsed(window: Pick<UsageWindow, 'pct'> | null | undefined): number | undefined {
  if (!window || !Number.isFinite(window.pct)) return undefined
  return Math.max(0, Math.min(100, Math.round(window.pct)))
}

/** Default name in the wizard: "<Agent> N", past the highest existing N. */
export function nextAccountName(agentName: string, existing: string[]): string {
  const prefix = `${agentName} `
  const max = existing.reduce((m, name) => {
    const n = name.startsWith(prefix) ? Number(name.slice(prefix.length)) : NaN
    return Number.isInteger(n) && n > m ? n : m
  }, 0)
  return `${prefix}${max + 1}`
}

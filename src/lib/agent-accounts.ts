import type { AgentAccount } from '@/tauri/accounts'

export type AccountSelection = { mode: 'fixed'; accountId?: string } | { mode: 'round-robin' }
/** Allocate profiles independently for each CLI; default participates in rotation. */
export function allocateAccounts(agentIds: string[], accounts: AgentAccount[], selections: Record<string, AccountSelection>): (string | undefined)[] {
  const next: Record<string, number> = {}
  return agentIds.map(agentId => {
    if (agentId !== 'claude-code' && agentId !== 'codex') return undefined
    const profiles = accounts.filter(account => account.agentId === agentId)
    const selection = selections[agentId]
    if (selection?.mode !== 'round-robin') return profiles.find(account => account.id === selection?.accountId)?.id
    const choices = [undefined, ...profiles.map(account => account.id)]
    const index = next[agentId] ?? 0
    next[agentId] = index + 1
    return choices[index % choices.length]
  })
}
/** Account for a pane split off in a workspace (SWA account-per-workspace).
 *  A fixed workspace account wins; round-robin continues the rotation after
 *  the workspace's existing panes of that agent; otherwise the split inherits
 *  the source pane's account when it runs the same agent. */
export function splitAccountFor(
  agentId: string | undefined,
  selection: AccountSelection | undefined,
  accounts: AgentAccount[],
  existing: { agentId?: string; accountId?: string }[],
  source: { agentId?: string; accountId?: string } | undefined
): string | undefined {
  if (agentId !== 'claude-code' && agentId !== 'codex') return undefined
  const profiles = accounts.filter(account => account.agentId === agentId)
  if (selection?.mode === 'round-robin') {
    const choices = [undefined, ...profiles.map(account => account.id)]
    return choices[existing.filter(leaf => leaf.agentId === agentId).length % choices.length]
  }
  const fixed = profiles.find(account => account.id === selection?.accountId)?.id
  if (fixed) return fixed
  return source?.agentId === agentId ? profiles.find(account => account.id === source.accountId)?.id : undefined
}
/** The per-agent selections worth keeping on a workspace (non-default ones). */
export function workspaceAccountSelections(selections: Record<string, AccountSelection>): Record<string, AccountSelection> | undefined {
  const kept = Object.fromEntries(Object.entries(selections).filter(([, selection]) =>
    selection.mode === 'round-robin' || selection.accountId !== undefined))
  return Object.keys(kept).length > 0 ? kept : undefined
}
export function accountLabel(accountId: string | undefined, accounts: AgentAccount[]): string {
  return accountId ? accounts.find(account => account.id === accountId)?.name ?? 'Unavailable account' : 'Default'
}

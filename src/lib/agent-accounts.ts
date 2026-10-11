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
export function accountLabel(accountId: string | undefined, accounts: AgentAccount[]): string {
  return accountId ? accounts.find(account => account.id === accountId)?.name ?? 'Unavailable account' : 'Default'
}

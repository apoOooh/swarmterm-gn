import { invoke } from '@tauri-apps/api/core'

export interface AgentAccount { id: string; agentId: 'claude-code' | 'codex'; name: string; configDir: string }
export type SaveAgentAccount = Omit<AgentAccount, 'id' | 'configDir'> & { id?: string; configDir?: string }
export const listAgentAccounts = (): Promise<AgentAccount[]> => invoke('list_agent_accounts')
export const saveAgentAccount = (account: SaveAgentAccount): Promise<AgentAccount> => invoke('save_agent_account', { account })
export const deleteAgentAccount = (id: string): Promise<void> => invoke('delete_agent_account', { id })

/** Metadata only — Rust reads the CLI's credential file and never returns tokens. */
export interface AccountStatus {
  state: 'connected' | 'expired' | 'loggedOut'
  plan?: string | null
  email?: string | null
  usage?: { fiveHour?: { pct: number; resetsAt?: number | null } | null; sevenDay?: { pct: number; resetsAt?: number | null } | null; at: number } | null
}
export const getAccountStatus = (agentId: AgentAccount['agentId'], accountId?: string): Promise<AccountStatus> =>
  invoke('get_account_status', { agentId, accountId: accountId ?? null })

import { invoke } from '@tauri-apps/api/core'

export interface AgentAccount { id: string; agentId: 'claude-code' | 'codex'; name: string; configDir: string }
export type SaveAgentAccount = Omit<AgentAccount, 'id' | 'configDir'> & { id?: string; configDir?: string }
export const listAgentAccounts = (): Promise<AgentAccount[]> => invoke('list_agent_accounts')
export const saveAgentAccount = (account: SaveAgentAccount): Promise<AgentAccount> => invoke('save_agent_account', { account })
export const deleteAgentAccount = (id: string): Promise<void> => invoke('delete_agent_account', { id })

import { create } from 'zustand'
import { listAgentAccounts, saveAgentAccount, deleteAgentAccount, type AgentAccount, type SaveAgentAccount } from '@/tauri/accounts'

interface AccountsState {
  accounts: AgentAccount[]
  error: string | null
  refresh: () => Promise<void>
  save: (account: SaveAgentAccount) => Promise<void>
  remove: (id: string) => Promise<void>
}
export const useAgentAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [], error: null,
  refresh: async () => {
    try { set({ accounts: await listAgentAccounts(), error: null }) }
    catch (error) { set({ error: String(error) }) }
  },
  save: async account => { await saveAgentAccount(account); await get().refresh() },
  remove: async id => { await deleteAgentAccount(id); await get().refresh() }
}))

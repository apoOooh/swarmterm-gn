import { create } from 'zustand'
import { listAgentAccounts, saveAgentAccount, deleteAgentAccount, type AgentAccount, type SaveAgentAccount } from '@/tauri/accounts'

interface AccountsState {
  accounts: AgentAccount[]
  error: string | null
  refresh: () => Promise<void>
  save: (account: SaveAgentAccount) => Promise<void>
  remove: (id: string) => Promise<void>
}
function sameAccounts(previous: AgentAccount[], next: AgentAccount[]): boolean {
  return previous.length === next.length && previous.every((account, index) => {
    const other = next[index]
    return account.id === other.id && account.agentId === other.agentId &&
      account.name === other.name && account.configDir === other.configDir
  })
}

export const useAgentAccountsStore = create<AccountsState>((set, get) => {
  let inFlight: Promise<void> | null = null
  const refreshAfterMutation = async (): Promise<void> => {
    // A read started before the write may return stale metadata. Finish it,
    // then explicitly read again rather than joining that earlier request.
    if (inFlight) await inFlight
    await get().refresh()
  }
  return {
    accounts: [], error: null,
    refresh: () => {
      if (inFlight) return inFlight
      const request = listAgentAccounts().then(accounts => {
        const current = get()
        const unchanged = sameAccounts(current.accounts, accounts)
        if (!unchanged || current.error !== null) {
          set({ accounts: unchanged ? current.accounts : accounts, error: null })
        }
      }).catch(error => {
        const message = String(error)
        if (get().error !== message) set({ error: message })
      }).finally(() => {
        if (inFlight === request) inFlight = null
      })
      inFlight = request
      return request
    },
    save: async account => { await saveAgentAccount(account); await refreshAfterMutation() },
    remove: async id => { await deleteAgentAccount(id); await refreshAfterMutation() }
  }
})

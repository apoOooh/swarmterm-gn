import { create } from 'zustand'
import { listAgentAccounts, saveAgentAccount, deleteAgentAccount, getAccountStatus, type AccountStatus, type AgentAccount, type SaveAgentAccount } from '@/tauri/accounts'
import { accountUsageKey } from '@/lib/account-usage'
import { useAccountUsageStore } from '@/store/account-usage-store'

/** Login watch after the wizard opens a login pane: poll until connected. */
const LOGIN_POLL_MS = 3000
const LOGIN_WATCH_MS = 5 * 60_000

interface AccountsState {
  accounts: AgentAccount[]
  error: string | null
  refresh: () => Promise<void>
  save: (account: SaveAgentAccount) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Keyed by `accountUsageKey`; absent = not checked yet. */
  statuses: Record<string, AccountStatus>
  refreshStatus: (agentId: AgentAccount['agentId'], accountId?: string) => Promise<AccountStatus | undefined>
  watchLogin: (agentId: AgentAccount['agentId'], accountId?: string) => void
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
  const watches = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    accounts: [], error: null, statuses: {},
    refreshStatus: async (agentId, accountId) => {
      try {
        const status = await getAccountStatus(agentId, accountId)
        set(s => ({ statuses: { ...s.statuses, [accountUsageKey(agentId, accountId)]: status } }))
        // Codex usage comes from its rollout files; it joins the same store
        // the Claude status line feeds, where the newer sample wins.
        if (status.usage) useAccountUsageStore.getState().apply(agentId, accountId, status.usage)
        return status
      } catch {
        // Fail-open: a removed profile or unreadable folder just stays grey.
        return undefined
      }
    },
    watchLogin: (agentId, accountId) => {
      const key = accountUsageKey(agentId, accountId)
      clearTimeout(watches.get(key))
      const deadline = Date.now() + LOGIN_WATCH_MS
      const tick = (): void => {
        void get().refreshStatus(agentId, accountId).then(status => {
          if (status?.state === 'connected' || Date.now() > deadline) { watches.delete(key); return }
          watches.set(key, setTimeout(tick, LOGIN_POLL_MS))
        })
      }
      watches.set(key, setTimeout(tick, LOGIN_POLL_MS))
    },
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

import { beforeEach, expect, it, vi } from 'vitest'
import { deleteAgentAccount, getAccountStatus, listAgentAccounts, saveAgentAccount, type AgentAccount } from '@/tauri/accounts'
import { useAgentAccountsStore } from './agent-accounts-store'

vi.mock('@/tauri/accounts', () => ({
  listAgentAccounts: vi.fn(), saveAgentAccount: vi.fn(), deleteAgentAccount: vi.fn(), getAccountStatus: vi.fn()
}))

const account: AgentAccount = { id: 'profile-1', agentId: 'codex', name: 'Work', configDir: '/profiles/work' }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  useAgentAccountsStore.setState({ accounts: [], error: null })
})

it('coalesces simultaneous refreshes but always rereads on a later explicit refresh', async () => {
  const pending = deferred<AgentAccount[]>()
  vi.mocked(listAgentAccounts).mockReturnValueOnce(pending.promise).mockResolvedValue([{ ...account }])
  const refresh = useAgentAccountsStore.getState().refresh
  const first = refresh()
  const second = refresh()
  expect(second).toBe(first)
  expect(listAgentAccounts).toHaveBeenCalledTimes(1)
  pending.resolve([account])
  await Promise.all([first, second])
  await refresh()
  expect(listAgentAccounts).toHaveBeenCalledTimes(2)
})

it('retains unchanged metadata references without notifying subscribers', async () => {
  useAgentAccountsStore.setState({ accounts: [account] })
  const original = useAgentAccountsStore.getState().accounts
  const subscriber = vi.fn()
  const unsubscribe = useAgentAccountsStore.subscribe(subscriber)
  try {
    vi.mocked(listAgentAccounts).mockResolvedValue([{ ...account }])
    await useAgentAccountsStore.getState().refresh()
    expect(useAgentAccountsStore.getState().accounts).toBe(original)
    expect(subscriber).not.toHaveBeenCalled()
  } finally { unsubscribe() }
})

it.each(['id', 'agentId', 'name', 'configDir'] as const)('publishes a changed %s', async field => {
  useAgentAccountsStore.setState({ accounts: [account] })
  const next = { ...account, [field]: field === 'agentId' ? 'claude-code' : 'changed' } as AgentAccount
  vi.mocked(listAgentAccounts).mockResolvedValue([next])
  await useAgentAccountsStore.getState().refresh()
  expect(useAgentAccountsStore.getState().accounts).toEqual([next])
  expect(useAgentAccountsStore.getState().accounts[0]).toBe(next)
})

it('retains accounts on error, suppresses repeated errors, and retries successfully', async () => {
  useAgentAccountsStore.setState({ accounts: [account] })
  const original = useAgentAccountsStore.getState().accounts
  const subscriber = vi.fn()
  const unsubscribe = useAgentAccountsStore.subscribe(subscriber)
  try {
    vi.mocked(listAgentAccounts).mockRejectedValue(new Error('unavailable'))
    await useAgentAccountsStore.getState().refresh()
    await useAgentAccountsStore.getState().refresh()
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(useAgentAccountsStore.getState().accounts).toBe(original)
    vi.mocked(listAgentAccounts).mockResolvedValue([{ ...account }])
    await useAgentAccountsStore.getState().refresh()
    expect(useAgentAccountsStore.getState().error).toBeNull()
    expect(useAgentAccountsStore.getState().accounts).toBe(original)
    expect(subscriber).toHaveBeenCalledTimes(2)
  } finally { unsubscribe() }
})

it.each(['save', 'remove'] as const)('rereads after %s when an earlier refresh returns stale metadata', async mutation => {
  const pending = deferred<AgentAccount[]>()
  const updated = mutation === 'save' ? [{ ...account, name: 'Renamed' }] : []
  vi.mocked(listAgentAccounts).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(updated)
  vi.mocked(saveAgentAccount).mockResolvedValue(account)
  vi.mocked(deleteAgentAccount).mockResolvedValue(undefined)
  const state = useAgentAccountsStore.getState()
  const earlierRefresh = state.refresh()
  const write = mutation === 'save' ? state.save({ ...account, name: 'Renamed' }) : state.remove(account.id)
  await Promise.resolve()
  expect(listAgentAccounts).toHaveBeenCalledTimes(1)
  pending.resolve([account])
  await Promise.all([earlierRefresh, write])
  expect(listAgentAccounts).toHaveBeenCalledTimes(2)
  expect(useAgentAccountsStore.getState().accounts).toEqual(updated)
})

it('save returns the stored profile even when the reread fails', async () => {
  // The wizard logs into the returned profile; it must never fall back to
  // the default login because a list refresh went wrong.
  vi.mocked(saveAgentAccount).mockResolvedValue(account)
  vi.mocked(listAgentAccounts).mockRejectedValue(new Error('io'))
  await expect(useAgentAccountsStore.getState().save({ agentId: 'codex', name: 'Work' })).resolves.toEqual(account)
})

it('stops watching a login once its profile is gone', async () => {
  vi.useFakeTimers()
  try {
    useAgentAccountsStore.setState({ accounts: [account] })
    vi.mocked(getAccountStatus).mockResolvedValue({ state: 'loggedOut' })
    useAgentAccountsStore.getState().watchLogin('codex', account.id)
    await vi.advanceTimersByTimeAsync(3000)
    expect(getAccountStatus).toHaveBeenCalledTimes(1)
    useAgentAccountsStore.setState({ accounts: [] })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getAccountStatus).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})

import { beforeEach, expect, it, vi } from 'vitest'
import { listAvailableAgents, type AgentAvailability } from '@/tauri/agents'
import { useAgentAvailabilityStore } from './agent-availability-store'

vi.mock('@/tauri/agents', () => ({ listAvailableAgents: vi.fn() }))

const entries: AgentAvailability[] = [
  { id: 'claude-code', available: true, detectedPath: '/bin/claude' },
  { id: 'codex', available: true, sessionHooks: false }
]
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: value => resolve(value) }
}

beforeEach(() => {
  vi.resetAllMocks()
  useAgentAvailabilityStore.setState({ availability: {}, codexSessionHooks: false })
})

it('shares an in-flight probe and probes again after it completes', async () => {
  const pending = deferred<AgentAvailability[]>()
  vi.mocked(listAvailableAgents).mockReturnValueOnce(pending.promise).mockResolvedValue(entries)
  const refresh = useAgentAvailabilityStore.getState().refresh
  const first = refresh()
  const second = refresh()
  expect(second).toBe(first)
  expect(listAvailableAgents).toHaveBeenCalledTimes(1)
  pending.resolve(entries)
  await Promise.all([first, second])
  await refresh()
  expect(listAvailableAgents).toHaveBeenCalledTimes(2)
})

it('keeps equal availability references and skips notifications despite reordered probe metadata', async () => {
  useAgentAvailabilityStore.setState({ availability: { 'claude-code': true, codex: true } })
  const original = useAgentAvailabilityStore.getState().availability
  const subscriber = vi.fn()
  const unsubscribe = useAgentAvailabilityStore.subscribe(subscriber)
  try {
    vi.mocked(listAvailableAgents).mockResolvedValue([...entries].reverse().map(entry => ({ ...entry, detectedPath: '/new/location' })))
    await useAgentAvailabilityStore.getState().refresh()
    expect(useAgentAvailabilityStore.getState().availability).toBe(original)
    expect(subscriber).not.toHaveBeenCalled()
  } finally { unsubscribe() }
})

it('publishes a session-hooks-only change without replacing the availability map', async () => {
  useAgentAvailabilityStore.setState({ availability: { 'claude-code': true, codex: true } })
  const original = useAgentAvailabilityStore.getState().availability
  const subscriber = vi.fn()
  const unsubscribe = useAgentAvailabilityStore.subscribe(subscriber)
  try {
    vi.mocked(listAvailableAgents).mockResolvedValue(entries.map(entry => ({ ...entry, sessionHooks: entry.id === 'codex' })))
    await useAgentAvailabilityStore.getState().refresh()
    expect(useAgentAvailabilityStore.getState().codexSessionHooks).toBe(true)
    expect(useAgentAvailabilityStore.getState().availability).toBe(original)
    expect(subscriber).toHaveBeenCalledTimes(1)
  } finally { unsubscribe() }
})

it('preserves the optimistic map on failure, then applies a changed availability on retry', async () => {
  useAgentAvailabilityStore.setState({ availability: { 'claude-code': true, codex: true }, codexSessionHooks: true })
  const original = useAgentAvailabilityStore.getState().availability
  const subscriber = vi.fn()
  const unsubscribe = useAgentAvailabilityStore.subscribe(subscriber)
  try {
    vi.mocked(listAvailableAgents).mockRejectedValueOnce(new Error('probe failed')).mockResolvedValueOnce([
      { id: 'claude-code', available: false }, { id: 'codex', available: true, sessionHooks: true }
    ])
    await useAgentAvailabilityStore.getState().refresh()
    expect(useAgentAvailabilityStore.getState().availability).toBe(original)
    expect(useAgentAvailabilityStore.getState().codexSessionHooks).toBe(true)
    expect(subscriber).not.toHaveBeenCalled()
    await useAgentAvailabilityStore.getState().refresh()
    expect(listAvailableAgents).toHaveBeenCalledTimes(2)
    expect(useAgentAvailabilityStore.getState().availability).toEqual({ 'claude-code': false, codex: true })
    expect(useAgentAvailabilityStore.getState().availability).not.toBe(original)
    expect(subscriber).toHaveBeenCalledTimes(1)
  } finally { unsubscribe() }
})

it('publishes added and removed agents even when existing boolean values stay equal', async () => {
  useAgentAvailabilityStore.setState({ availability: { 'claude-code': true, codex: true }, codexSessionHooks: true })
  vi.mocked(listAvailableAgents).mockResolvedValueOnce([{ id: 'claude-code', available: true }, { id: 'qwen', available: true }])
  await useAgentAvailabilityStore.getState().refresh()
  expect(useAgentAvailabilityStore.getState().availability).toEqual({ 'claude-code': true, qwen: true })
  expect(useAgentAvailabilityStore.getState().codexSessionHooks).toBe(false)
})

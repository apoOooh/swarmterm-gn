import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reg = vi.hoisted(() => ({
  deliverPromptToTerminal: vi.fn(),
  submitTerminalPrompt: vi.fn(),
  getTerminalGeneration: vi.fn(() => 1 as number | undefined),
  getTerminalStatus: vi.fn(() => ({ kind: 'running' }))
}))
vi.mock('@/lib/terminal-registry', () => reg)
vi.mock('@/tauri/terminal', () => ({ isTerminalAgentAlive: vi.fn(async () => false) }))

import { deliverHandoffBrief } from './handoff-delivery'
import { useAgentStateStore } from '@/store/agent-state-store'

const ID = 't1'

function callbacks() {
  return { held: vi.fn(), delivered: vi.fn(), pasted: vi.fn(), failed: vi.fn() }
}

async function run(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('deliverHandoffBrief liveness proof', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.values(reg).forEach((f) => f.mockClear())
    // The screen detector says idle: exactly what a CLI that exited back to
    // PowerShell looks like.
    useAgentStateStore.setState({ byId: { [ID]: { state: 'idle' } as never } })
  })
  afterEach(() => vi.useRealTimers())

  it('does not paste when the agent process is gone though the screen looks idle', async () => {
    const cb = callbacks()
    deliverHandoffBrief(ID, 1, 'brief', cb, async () => false)
    await run(10_000)
    expect(reg.deliverPromptToTerminal).not.toHaveBeenCalled()
    expect(cb.failed).toHaveBeenCalledOnce()
    expect(cb.failed.mock.calls[0][0]).toMatch(/not running/)
  })

  it('fails closed when the probe errors', async () => {
    const cb = callbacks()
    deliverHandoffBrief(ID, 1, 'brief', cb, () => Promise.reject(new Error('ipc')))
    await run(10_000)
    expect(reg.deliverPromptToTerminal).not.toHaveBeenCalled()
    expect(cb.failed).toHaveBeenCalledOnce()
  })

  it('withholds Enter when the agent dies between paste and submit', async () => {
    const cb = callbacks()
    let alive = true
    const probe = vi.fn(async () => {
      const now = alive
      alive = false
      return now
    })
    deliverHandoffBrief(ID, 1, 'brief', cb, probe)
    await run(10_000)
    expect(reg.deliverPromptToTerminal).toHaveBeenCalledOnce()
    expect(reg.submitTerminalPrompt).not.toHaveBeenCalled()
    expect(cb.pasted).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('pastes and submits when the agent is proven alive both times', async () => {
    const cb = callbacks()
    deliverHandoffBrief(ID, 1, 'brief', cb, async () => true)
    await run(10_000)
    expect(reg.deliverPromptToTerminal).toHaveBeenCalledOnce()
    expect(reg.submitTerminalPrompt).toHaveBeenCalledOnce()
    expect(cb.delivered).toHaveBeenCalledOnce()
  })

  it('cancelling during the probe sends nothing', async () => {
    const cb = callbacks()
    let resolve: (v: boolean) => void = () => {}
    const probe = () => new Promise<boolean>((r) => (resolve = r))
    const cancel = deliverHandoffBrief(ID, 1, 'brief', cb, probe)
    await run(4_000)
    cancel()
    resolve(true)
    await run(5_000)
    expect(reg.deliverPromptToTerminal).not.toHaveBeenCalled()
  })
})

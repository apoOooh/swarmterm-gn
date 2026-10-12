import { describe, expect, it, vi } from 'vitest'
import { runRoutine, tickRoutines, type RoutineDeps, type StartResult } from './routine-scheduler'
import type { Routine } from './routines'

const MIN = 60_000
const anchor = new Date(2026, 9, 12, 8).getTime()

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'r1',
    name: 'Hourly',
    enabled: true,
    agentId: 'claude-code',
    brief: 'Check CI',
    worktree: false,
    schedule: { kind: 'interval', everyMinutes: 60 },
    missed: 'run-once',
    lastScheduledAt: anchor,
    ...over
  }
}

function deps(over: Partial<RoutineDeps> = {}): RoutineDeps & { patch: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> } {
  return {
    isBusy: () => false,
    start: vi.fn(async (): Promise<StartResult> => ({ terminalId: 't9' })),
    patch: vi.fn(),
    notify: vi.fn(),
    ...over
  } as never
}

describe('tickRoutines', () => {
  it('consumes the slot, starts and notifies', async () => {
    const d = deps()
    await tickRoutines([routine()], anchor + 61 * MIN, d)
    expect(d.patch).toHaveBeenCalledWith('r1', { lastScheduledAt: anchor + 60 * MIN })
    expect(d.start).toHaveBeenCalledTimes(1)
    expect(d.patch).toHaveBeenCalledWith('r1', expect.objectContaining({ activeTerminalId: 't9' }))
    expect(d.notify).toHaveBeenCalledWith('t9', 'Routine "Hourly" started', 'Hourly')
  })
  it('drops the slot on overlap without starting', async () => {
    const d = deps({ isBusy: () => true })
    await tickRoutines([routine({ activeTerminalId: 't1' })], anchor + 61 * MIN, d)
    expect(d.start).not.toHaveBeenCalled()
    expect(d.patch).toHaveBeenCalledWith('r1', { lastScheduledAt: anchor + 60 * MIN })
    expect(d.notify.mock.calls[0][1]).toMatch(/previous run still busy/)
  })
  it('a failed start is reported once and not retried', async () => {
    const d = deps({ start: vi.fn(async () => ({ error: 'no workspace' })) })
    await tickRoutines([routine()], anchor + 61 * MIN, d)
    expect(d.notify.mock.calls[0][1]).toMatch(/not started: no workspace/)
    expect(d.patch).toHaveBeenCalledTimes(1)
  })
  it('labels a catch-up run', async () => {
    const d = deps()
    await tickRoutines([routine()], anchor + 5 * 60 * MIN + 10 * MIN, d)
    expect(d.start).toHaveBeenCalledTimes(1)
    expect(d.notify.mock.calls[0][1]).toMatch(/caught up/)
  })
})

describe('runRoutine', () => {
  it('refuses a second start while one is provisioning', async () => {
    let release!: (v: StartResult) => void
    const d = deps({ start: vi.fn(() => new Promise<StartResult>((r) => (release = r))) })
    const first = runRoutine(routine(), d)
    expect(await runRoutine(routine(), d)).toEqual({ error: 'already starting' })
    release({ terminalId: 't1', branch: 'swarm/claude-code-1' })
    await first
    expect(d.notify).toHaveBeenCalledWith('t1', 'Routine "Hourly" started in swarm/claude-code-1', 'Hourly')
  })
})

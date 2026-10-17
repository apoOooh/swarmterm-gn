import { describe, expect, it, vi } from 'vitest'
import { describeOutcome, runRoutine, tickRoutines, type CommandResult, type RoutineDeps, type StartResult } from './routine-scheduler'
import type { Routine } from './routines'

const MIN = 60_000
const anchor = new Date(2026, 9, 12, 8).getTime()

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'r1',
    name: 'Hourly',
    enabled: true,
    kind: 'agent',
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
    runCommand: vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, timedOut: false, output: 'ok', durationMs: 1200 })),
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

describe('command routines', () => {
  const cmd = (over: Partial<Routine> = {}): Routine =>
    routine({ id: 'c1', name: 'Board', kind: 'command', agentId: '', brief: '', command: 'refresh', cwd: 'C:/work', timeoutMinutes: 5, ...over })

  it('runs the line, records the result and keeps the bell quiet on success', async () => {
    const d = deps()
    await tickRoutines([cmd()], anchor + 61 * MIN, d)
    expect(d.start).not.toHaveBeenCalled()
    expect(d.runCommand).toHaveBeenCalledTimes(1)
    expect(d.patch).toHaveBeenCalledWith('c1', expect.objectContaining({ lastResult: 'exit 0 · 1.2 s' }))
    expect(d.notify).not.toHaveBeenCalled()
  })
  it('reports a failure with the last output line', async () => {
    const d = deps({ runCommand: vi.fn(async () => ({ exitCode: 2, timedOut: false, output: 'a' + String.fromCharCode(10) + 'boom', durationMs: 50 })) })
    await tickRoutines([cmd()], anchor + 61 * MIN, d)
    expect(d.notify).toHaveBeenCalledWith('', 'Routine "Board" failed: exit 2 · 0.1 s', 'Board · boom')
  })
  it('reports a timeout and a start error', async () => {
    const t = deps({ runCommand: vi.fn(async () => ({ exitCode: null, timedOut: true, output: '', durationMs: 300_000 })) })
    await tickRoutines([cmd()], anchor + 61 * MIN, t)
    expect(t.notify.mock.calls[0][1]).toBe('Routine "Board" failed: timed out after 300 s')
    const e = deps({ runCommand: vi.fn(async () => Promise.reject('no folder')) })
    await tickRoutines([cmd()], anchor + 61 * MIN, e)
    expect(e.notify.mock.calls[0][1]).toBe('Routine "Board" not started: no folder')
  })
  it('drops a slot while the previous run is still going', async () => {
    let finish!: (v: CommandResult) => void
    const d = deps({ runCommand: vi.fn(() => new Promise<CommandResult>((r) => (finish = r))) })
    const first = runRoutine(cmd(), d)
    await tickRoutines([cmd()], anchor + 61 * MIN, d)
    expect(d.runCommand).toHaveBeenCalledTimes(1)
    expect(d.patch).toHaveBeenCalledWith('c1', { lastScheduledAt: anchor + 60 * MIN })
    expect(d.notify.mock.calls[0][1]).toMatch(/previous run still busy/)
    finish({ exitCode: 0, timedOut: false, output: '', durationMs: 1 })
    await first
  })
  it('describes outcomes', () => {
    expect(describeOutcome({ exitCode: 0, timedOut: false, output: '', durationMs: 42_400 })).toBe('exit 0 · 42 s')
  })
})

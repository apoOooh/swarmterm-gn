import { describe, expect, it, vi } from 'vitest'
import type { CreateTerminalResult, PtyOut } from '@/tauri/terminal'
import { TerminalSession, type SessionDeps } from '@/lib/terminal-session'

/** A fresh set of mocked tauri deps; createTerminal resolves ok by default. */
function makeDeps(): SessionDeps & {
  /** Push a pty message into the latest createTerminal channel. */
  emit: (msg: PtyOut) => void
  /** Every createTerminal channel, in call order, for targeting old generations. */
  channels: ((msg: PtyOut) => void)[]
} {
  const channels: ((msg: PtyOut) => void)[] = []
  const createTerminal = vi.fn(
    (_id: string, _options, cb: (msg: PtyOut) => void) => {
      channels.push(cb)
      return Promise.resolve({ ok: true, pid: 1, shell: 'sh' })
    }
  )
  const killTerminal = vi.fn(() => Promise.resolve())
  return {
    createTerminal: createTerminal as SessionDeps['createTerminal'],
    killTerminal: killTerminal as SessionDeps['killTerminal'],
    channels,
    emit: (msg) => channels[channels.length - 1]?.(msg)
  }
}

const OPTS = { cols: 80, rows: 24, cwd: '/tmp' }

describe('TerminalSession', () => {
  it('releases a generation whose create resolves after dispose, never a stale one', async () => {
    const deps = makeDeps()
    let complete!: (r: CreateTerminalResult) => void
    vi.mocked(deps.createTerminal).mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const releaseOutput = vi.fn()
    const session = new TerminalSession('t1', { write: vi.fn() }, { ...deps, releaseOutput })
    session.start(OPTS)
    session.dispose()
    expect(releaseOutput).not.toHaveBeenCalled()
    complete({ ok: true, pid: 1, shell: 'sh', spawnId: 'late' })
    await Promise.resolve()
    await Promise.resolve()
    expect(releaseOutput).toHaveBeenCalledWith('t1', 'late')
    expect(deps.killTerminal).toHaveBeenCalled()
  })

  it('releases the flow gate of its live generation on dispose', async () => {
    const deps = makeDeps()
    vi.mocked(deps.createTerminal).mockImplementation((_id, _o, cb) => {
      deps.channels.push(cb)
      return Promise.resolve({ ok: true, pid: 1, shell: 'sh', spawnId: 'gen-7' })
    })
    const releaseOutput = vi.fn()
    const session = new TerminalSession('t1', { write: vi.fn() }, { ...deps, releaseOutput })
    session.start(OPTS)
    await Promise.resolve()
    await Promise.resolve()
    session.dispose()
    session.dispose()
    expect(releaseOutput).toHaveBeenCalledTimes(1)
    expect(releaseOutput).toHaveBeenCalledWith('t1', 'gen-7')
  })

  it('acks parsed output per generation, batched, once the spawn id is known', async () => {
    const deps = makeDeps()
    vi.mocked(deps.createTerminal).mockImplementation((_id, _o, cb) => {
      deps.channels.push(cb)
      return Promise.resolve({ ok: true, pid: 1, shell: 'sh', spawnId: 'gen-1' })
    })
    const ackOutput = vi.fn()
    const parsed: (() => void)[] = []
    const write = vi.fn((_d: string, onParsed?: () => void) => { if (onParsed) parsed.push(onParsed) })
    const session = new TerminalSession('t1', { write }, { ...deps, ackOutput })
    session.start(OPTS)
    const chunk = 'x'.repeat(16 * 1024)
    for (let i = 0; i < 8; i++) deps.emit({ type: 'data', payload: chunk })
    // Nothing parsed yet: no acks, however much was written.
    expect(ackOutput).not.toHaveBeenCalled()
    for (const p of parsed.splice(0)) p()
    await Promise.resolve()
    await Promise.resolve()
    // 128 KB parsed = two 64 KB batches, not eight calls.
    const total = ackOutput.mock.calls.reduce((n, c) => n + (c[2] as number), 0)
    expect(total).toBe(128 * 1024)
    expect(ackOutput.mock.calls.length).toBeLessThanOrEqual(2)
    expect(ackOutput.mock.calls.every(c => c[0] === 't1' && c[1] === 'gen-1')).toBe(true)
  })

  it('hands a reattached pane its history through replay, not write', () => {
    const deps = makeDeps()
    const write = vi.fn()
    const replay = vi.fn()
    const session = new TerminalSession('t1', { write, replay }, deps)
    session.start(OPTS)
    const payload = { data: 'history', cols: 100, rows: 30, truncated: true }
    deps.emit({ type: 'replay', payload })
    deps.emit({ type: 'data', payload: 'live' })
    expect(replay).toHaveBeenCalledWith(payload, undefined)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('live', undefined)
  })

  it('writes a replay as plain output when the sink has no replay handler', () => {
    const deps = makeDeps()
    const write = vi.fn()
    const session = new TerminalSession('t1', { write }, deps)
    session.start(OPTS)
    deps.emit({ type: 'replay', payload: { data: 'history', cols: 80, rows: 24, truncated: false } })
    expect(write).toHaveBeenCalledWith('history', undefined)
  })

  it('cleans up a successful creation that completes after disposal', async () => {
    const deps = makeDeps()
    let complete!: (result: CreateTerminalResult) => void
    vi.mocked(deps.createTerminal).mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const write = vi.fn()
    const session = new TerminalSession('t1', { write }, deps)
    session.start(OPTS)
    session.dispose()
    expect(deps.killTerminal).toHaveBeenCalledTimes(1)

    complete({ ok: true, pid: 1, shell: 'sh' })
    await Promise.resolve()
    expect(deps.killTerminal).toHaveBeenCalledTimes(2)
    expect(session.getStatus().kind).toBe('connecting')
    expect(write).not.toHaveBeenCalled()
  })

  it('does not clean up a failed creation after disposal', async () => {
    const deps = makeDeps()
    let complete!: (result: CreateTerminalResult) => void
    vi.mocked(deps.createTerminal).mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)
    session.start(OPTS)
    session.dispose()
    complete({ ok: false, error: 'Profile unavailable' })
    await Promise.resolve()
    expect(deps.killTerminal).toHaveBeenCalledTimes(1)
  })

  it('repeats a pending respawn kill when delayed creation becomes ready', async () => {
    const deps = makeDeps()
    let complete!: (result: CreateTerminalResult) => void
    vi.mocked(deps.createTerminal).mockImplementationOnce((_id, _options, callback) => {
      deps.channels.push(callback)
      return new Promise(resolve => { complete = resolve })
    })
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)
    session.start(OPTS)
    session.respawn({ ...OPTS, cwd: '/other', accountId: 'other-profile' })
    expect(deps.killTerminal).toHaveBeenCalledTimes(1)
    complete({ ok: true, pid: 1, shell: 'sh' })
    await Promise.resolve()
    expect(deps.killTerminal).toHaveBeenCalledTimes(2)
    expect(deps.createTerminal).toHaveBeenCalledTimes(1)
    expect(session.getStatus().kind).toBe('connecting')

    deps.emit({ type: 'exit', payload: { exitCode: 0 } })
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
    expect(deps.createTerminal).toHaveBeenLastCalledWith('t1', { ...OPTS, cwd: '/other', accountId: 'other-profile' }, expect.any(Function))
    await Promise.resolve()
    expect(session.getStatus().kind).toBe('running')
  })

  it('does not kill a replacement when an older successful acknowledgement arrives', async () => {
    const deps = makeDeps()
    let complete!: (result: CreateTerminalResult) => void
    vi.mocked(deps.createTerminal).mockImplementationOnce((_id, _options, callback) => {
      deps.channels.push(callback)
      return new Promise(resolve => { complete = resolve })
    })
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)
    session.start(OPTS)
    deps.emit({ type: 'exit', payload: { exitCode: 0 } })
    session.retry(OPTS)
    await Promise.resolve()
    expect(session.getStatus().kind).toBe('running')
    complete({ ok: true, pid: 1, shell: 'sh' })
    await Promise.resolve()
    expect(deps.killTerminal).not.toHaveBeenCalled()
    expect(session.getStatus().kind).toBe('running')
  })

  it('starts the newly selected profile if pending creation fails', async () => {
    const deps = makeDeps()
    let complete!: (result: CreateTerminalResult) => void
    vi.mocked(deps.createTerminal).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)
    session.start({ ...OPTS, accountId: 'unavailable-profile' })
    const next = { ...OPTS, accountId: 'available-profile' }
    session.respawn(next)
    complete({ ok: false, error: 'Profile unavailable' })
    await Promise.resolve()
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
    expect(deps.createTerminal).toHaveBeenLastCalledWith('t1', next, expect.any(Function))
    await Promise.resolve()
    expect(session.getStatus().kind).toBe('running')
  })

  it('spawns the pty only once across repeated start() calls (remounts)', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    session.start(OPTS) // detach + re-attach from a tree-collapse remount
    session.start(OPTS)

    expect(deps.createTerminal).toHaveBeenCalledTimes(1)
    expect(deps.killTerminal).not.toHaveBeenCalled()
  })

  it('routes pty data into the sink', () => {
    const deps = makeDeps()
    const write = vi.fn()
    const session = new TerminalSession('t1', { write }, deps)

    session.start(OPTS)
    deps.emit({ type: 'data', payload: 'hello' })

    expect(write).toHaveBeenCalledWith('hello', undefined)
  })

  it('kills the pty exactly once on dispose, even if called twice', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    session.dispose()
    session.dispose()

    expect(deps.killTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not kill a session that never started', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.dispose()

    expect(deps.killTerminal).not.toHaveBeenCalled()
  })

  it('does not start again after dispose', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    session.dispose()
    session.start(OPTS)

    expect(deps.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('re-spawns the pty on retry after the process exits', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    deps.emit({ type: 'exit', payload: { exitCode: 0 } })
    expect(session.getStatus()).toEqual({ kind: 'exited', exitCode: 0 })

    session.retry(OPTS)

    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
    expect(session.getStatus()).toEqual({ kind: 'connecting' })
  })

  it('exposes a generation that changes on retry and dispose', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)
    session.start(OPTS)
    const first = session.getGeneration()
    deps.emit({ type: 'exit', payload: { exitCode: 1 } })
    session.retry(OPTS)
    expect(session.getGeneration()).not.toBe(first)
    const second = session.getGeneration()
    session.dispose()
    expect(session.getGeneration()).not.toBe(second)
  })

  it('ignores pty messages from a superseded generation after retry', () => {
    const deps = makeDeps()
    const write = vi.fn()
    const session = new TerminalSession('t1', { write }, deps)

    session.start(OPTS)
    const staleChannel = deps.channels[0]
    deps.emit({ type: 'exit', payload: { exitCode: 1 } })
    session.retry(OPTS)

    // A late message from the OLD pty channel must not reach the sink.
    staleChannel({ type: 'data', payload: 'ghost' })
    expect(write).not.toHaveBeenCalledWith('ghost', undefined)
  })

  it('kills a running pty and re-spawns only after its exit is observed', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    expect(deps.createTerminal).toHaveBeenCalledTimes(1)

    // Switch on a LIVE pty: must kill, but must NOT spawn yet (backend id still live).
    session.respawn({ ...OPTS, cwd: '/other' })
    expect(deps.killTerminal).toHaveBeenCalledTimes(1)
    expect(deps.createTerminal).toHaveBeenCalledTimes(1)
    expect(session.getStatus()).toEqual({ kind: 'connecting' })

    // The dying pty reports exit (backend has now freed the id) -> fresh spawn.
    deps.emit({ type: 'exit', payload: { exitCode: 0 } })
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
    expect(session.getStatus()).toEqual({ kind: 'connecting' })
  })

  it('respawns immediately, without a kill, when the pty already exited', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    deps.emit({ type: 'exit', payload: { exitCode: 0 } })
    expect(session.getStatus()).toEqual({ kind: 'exited', exitCode: 0 })

    session.respawn(OPTS)
    expect(deps.killTerminal).not.toHaveBeenCalled()
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
  })
})

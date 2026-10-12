import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPaneState } from '@/lib/agent-state/rollup'
import type { NotificationPrefs } from '@/lib/notification-pref'
import type { CommandState, FinishedCommand } from '@/lib/shell-marks'
import { COALESCE_MS, NOTIFY_DELAY_MS, startNotificationWatch, type NotificationWatchDeps } from './notification-watch'

const s = (state: AgentPaneState['state'], seen = true): AgentPaneState => ({ state, seen, sinceMs: 0 })
const fin = (durationMs: number, exitCode?: number): FinishedCommand => ({
  startedAt: 100_000,
  finishedAt: 100_000 + durationMs,
  durationMs,
  ...(exitCode === undefined ? {} : { exitCode })
})
const cmd = (phase: CommandState['phase'], last?: FinishedCommand): CommandState =>
  last === undefined ? { phase } : { phase, last }

interface Harness {
  deps: NotificationWatchDeps
  emit: (next: Record<string, AgentPaneState>, prev: Record<string, AgentPaneState>) => void
  emitCommands: (next: Record<string, CommandState>, prev: Record<string, CommandState>) => void
  fireTimers: () => void
  playChime: ReturnType<typeof vi.fn>
  sendSystem: ReturnType<typeof vi.fn>
  states: { current: Record<string, AgentPaneState> }
  commands: { current: Record<string, CommandState> }
  prefs: NotificationPrefs
  focus: { window: boolean; watchedId: string | null }
  clock: { now: number }
  titles: Record<string, string>
}

function harness(): Harness {
  let listener: ((n: Record<string, AgentPaneState>, p: Record<string, AgentPaneState>) => void) | null = null
  let cmdListener: ((n: Record<string, CommandState>, p: Record<string, CommandState>) => void) | null = null
  const timers = new Map<number, () => void>()
  let nextHandle = 1
  const playChime = vi.fn()
  const sendSystem = vi.fn()
  const states = { current: {} as Record<string, AgentPaneState> }
  const commands = { current: {} as Record<string, CommandState> }
  const prefs: NotificationPrefs = { sound: true, system: true, perAgent: {} }
  const focus = { window: true, watchedId: null as string | null }
  const clock = { now: 0 }
  const titles: Record<string, string> = {}
  const deps: NotificationWatchDeps = {
    subscribeAgentStates: (l) => {
      listener = l
      return () => { listener = null }
    },
    getAgentStates: () => states.current,
    subscribeCommands: (l) => {
      cmdListener = l
      return () => { cmdListener = null }
    },
    getCommandStates: () => commands.current,
    isPaneWatched: (id) => focus.watchedId === id,
    isWindowFocused: () => focus.window,
    getAgentId: (id) =>
      id === 'plain' ? undefined : id.startsWith('sh') ? 'terminal' : id.startsWith('cx') ? 'codex' : 'claude-code',
    getPrefs: () => prefs,
    getPaneTitle: (id) => titles[id] ?? 'my pane',
    now: () => clock.now,
    playChime,
    sendSystemNotification: sendSystem,
    setTimer: (fn, ms) => {
      expect(ms).toBe(NOTIFY_DELAY_MS)
      const h = nextHandle++
      timers.set(h, fn)
      return h
    },
    clearTimer: (h) => { timers.delete(h as number) }
  }
  return {
    deps,
    emit: (next, prev) => {
      states.current = next
      listener?.(next, prev)
    },
    emitCommands: (next, prev) => {
      commands.current = next
      cmdListener?.(next, prev)
    },
    fireTimers: () => {
      const fns = [...timers.values()]
      timers.clear()
      fns.forEach((fn) => fn())
    },
    playChime,
    sendSystem,
    states,
    commands,
    prefs,
    focus,
    clock,
    titles
  }
}

describe('startNotificationWatch', () => {
  let h: Harness
  beforeEach(() => { h = harness() })

  it('chimes after the delay when blocked persists (window focused → no banner)', () => {
    startNotificationWatch(h.deps)
    h.emit({ t1: s('blocked') }, { t1: s('working') })
    expect(h.playChime).not.toHaveBeenCalled()
    h.fireTimers()
    expect(h.playChime).toHaveBeenCalledWith('attention')
    expect(h.sendSystem).not.toHaveBeenCalled()
  })

  it('adds the banner when the window is unfocused at fire time', () => {
    startNotificationWatch(h.deps)
    h.emit({ t1: s('blocked') }, { t1: s('working') })
    h.focus.window = false
    h.fireTimers()
    expect(h.sendSystem).toHaveBeenCalledWith({ title: 'Claude Code needs your input', body: 'my pane' })
  })

  it('drops when the state resolved during the delay', () => {
    startNotificationWatch(h.deps)
    h.emit({ t1: s('blocked') }, { t1: s('working') })
    h.states.current = { t1: s('working') }
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
  })

  it('a newer transition replaces the pending one', () => {
    startNotificationWatch(h.deps)
    h.emit({ t1: s('blocked') }, { t1: s('working') })
    h.emit({ t1: s('idle', false) }, { t1: s('blocked') })
    h.fireTimers()
    expect(h.playChime).toHaveBeenCalledTimes(1)
    expect(h.playChime).toHaveBeenCalledWith('completion')
  })

  it('removal cancels the pending notification', () => {
    startNotificationWatch(h.deps)
    h.emit({ t1: s('blocked') }, { t1: s('working') })
    h.emit({}, { t1: s('blocked') })
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
  })

  it('skips panes without an agent id', () => {
    startNotificationWatch(h.deps)
    h.emit({ plain: s('blocked') }, {})
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
  })

  it('disposer cancels pending timers', () => {
    const stop = startNotificationWatch(h.deps)
    h.emit({ t1: s('blocked') }, { t1: s('working') })
    stop()
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
  })

  it('flushes every entry due within COALESCE_MS as one chime + one grouped banner', () => {
    startNotificationWatch(h.deps)
    h.titles.t1 = 'pane A'
    h.titles.t2 = 'pane B'
    h.emit({ t1: s('blocked'), t2: s('working') }, { t1: s('working'), t2: s('working') })
    h.clock.now = 200
    h.emit({ t1: s('blocked'), t2: s('blocked') }, { t1: s('blocked'), t2: s('working') })
    h.focus.window = false
    h.clock.now = NOTIFY_DELAY_MS
    h.fireTimers()
    expect(h.playChime).toHaveBeenCalledTimes(1)
    expect(h.playChime).toHaveBeenCalledWith('attention')
    expect(h.sendSystem).toHaveBeenCalledTimes(1)
    expect(h.sendSystem).toHaveBeenCalledWith({ title: '2 Claude Code panes need your input', body: 'pane A · pane B' })
  })

  it('attention wins the tone and leads the copy even when the completion was armed first', () => {
    startNotificationWatch(h.deps)
    h.titles.cx1 = 'build'
    h.titles.t1 = 'review'
    h.emit({ cx1: s('idle', false), t1: s('working') }, { cx1: s('working'), t1: s('working') })
    h.clock.now = 100
    h.emit({ cx1: s('idle', false), t1: s('blocked') }, { cx1: s('idle', false), t1: s('working') })
    h.focus.window = false
    h.clock.now = NOTIFY_DELAY_MS
    h.fireTimers()
    expect(h.playChime).toHaveBeenCalledTimes(1)
    expect(h.playChime).toHaveBeenCalledWith('attention')
    expect(h.sendSystem).toHaveBeenCalledWith({ title: 'Claude Code needs your input · Codex finished', body: 'review · build' })
  })

  it('an entry due later than COALESCE_MS after the firing one is left for its own timer', () => {
    startNotificationWatch(h.deps)
    h.emit({ t1: s('blocked'), t2: s('working') }, { t1: s('working'), t2: s('working') })
    h.clock.now = NOTIFY_DELAY_MS - COALESCE_MS + 300
    h.emit({ t1: s('blocked'), t2: s('blocked') }, { t1: s('blocked'), t2: s('working') })
    h.focus.window = false
    h.clock.now = NOTIFY_DELAY_MS
    h.fireTimers()
    expect(h.playChime).toHaveBeenCalledTimes(2)
    expect(h.sendSystem).toHaveBeenCalledTimes(2)
    expect(h.sendSystem).toHaveBeenNthCalledWith(1, { title: 'Claude Code needs your input', body: 'my pane' })
    expect(h.sendSystem).toHaveBeenNthCalledWith(2, { title: 'Claude Code needs your input', body: 'my pane' })
  })

  it('a batch whose other entry resolved during the delay falls back to single-entry copy', () => {
    startNotificationWatch(h.deps)
    h.emit({ t1: s('blocked'), t2: s('blocked') }, { t1: s('working'), t2: s('working') })
    h.states.current = { t1: s('blocked'), t2: s('working') }
    h.focus.window = false
    h.clock.now = NOTIFY_DELAY_MS
    h.fireTimers()
    expect(h.playChime).toHaveBeenCalledTimes(1)
    expect(h.sendSystem).toHaveBeenCalledWith({ title: 'Claude Code needs your input', body: 'my pane' })
  })
})

describe('startNotificationWatch — commands (OSC 133)', () => {
  let h: Harness
  beforeEach(() => { h = harness() })
  const L = fin(12_000, 1)

  it('a long command finishing in an unwatched plain pane chimes after the hold, with a banner when unfocused', () => {
    startNotificationWatch(h.deps)
    h.titles.sh1 = 'build'
    h.emitCommands({ sh1: cmd('finished', L) }, { sh1: cmd('running') })
    expect(h.playChime).not.toHaveBeenCalled()
    h.focus.window = false
    h.fireTimers()
    expect(h.playChime).toHaveBeenCalledWith('command')
    expect(h.sendSystem).toHaveBeenCalledWith({ title: 'Command failed (exit 1 · 12s)', body: 'build' })
  })

  it('a short command, or a pane without a registry entry, never arms', () => {
    startNotificationWatch(h.deps)
    h.emitCommands({ sh1: cmd('finished', fin(3_000)) }, { sh1: cmd('running') })
    h.emitCommands({ plain: cmd('finished', L) }, {})
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
  })

  it('still fires after the prompt redraw that follows D (re-validated on `last`, not on phase)', () => {
    startNotificationWatch(h.deps)
    h.emitCommands({ sh1: cmd('finished', L) }, { sh1: cmd('running') })
    h.emitCommands({ sh1: cmd('prompt', L) }, { sh1: cmd('finished', L) })
    h.fireTimers()
    expect(h.playChime).toHaveBeenCalledTimes(1)
    expect(h.playChime).toHaveBeenCalledWith('command')
  })

  it('drops when a newer (short) command replaced `last` during the hold, or the entry was cleared', () => {
    startNotificationWatch(h.deps)
    h.emitCommands({ sh1: cmd('finished', L) }, { sh1: cmd('running') })
    h.commands.current = { sh1: cmd('prompt', fin(500)) }
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
    const M = fin(12_000)
    h.emitCommands({ sh1: cmd('finished', M) }, { sh1: cmd('running') })
    h.emitCommands({}, { sh1: cmd('finished', M) })
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
  })

  it('a watched pane and the Terminal per-agent toggle both silence it', () => {
    startNotificationWatch(h.deps)
    h.focus.watchedId = 'sh1'
    h.emitCommands({ sh1: cmd('finished', L) }, { sh1: cmd('running') })
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
    h.focus.watchedId = null
    h.prefs.perAgent = { terminal: false }
    h.emitCommands({ sh2: cmd('finished', L) }, { sh2: cmd('running') })
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
  })

  it('a command and an agent completion in one burst share the chime (agent tone) and one banner', () => {
    startNotificationWatch(h.deps)
    h.titles.t1 = 'pane A'
    h.titles.sh1 = 'build'
    h.emit({ t1: s('idle', false) }, { t1: s('working') })
    h.emitCommands({ sh1: cmd('finished', fin(12_000)) }, { sh1: cmd('running') })
    h.focus.window = false
    h.clock.now = NOTIFY_DELAY_MS
    h.fireTimers()
    expect(h.playChime).toHaveBeenCalledTimes(1)
    expect(h.playChime).toHaveBeenCalledWith('completion')
    expect(h.sendSystem).toHaveBeenCalledTimes(1)
    expect(h.sendSystem).toHaveBeenCalledWith({
      title: 'Claude Code finished · Command finished (12s)',
      body: 'pane A · build'
    })
  })

  it('the disposer unsubscribes the command listener too', () => {
    const stop = startNotificationWatch(h.deps)
    stop()
    h.emitCommands({ sh1: cmd('finished', L) }, { sh1: cmd('running') })
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
  })
})

describe('startNotificationWatch → notification center feed', () => {
  let h: Harness
  beforeEach(() => { h = harness() })

  it('records a still-current fact even when every chime/banner pref is off', () => {
    const record = vi.fn()
    h.prefs.sound = false
    h.prefs.system = false
    h.clock.now = 5000
    startNotificationWatch({ ...h.deps, record })
    h.emit({ t1: s('blocked') }, { t1: s('working') })
    h.fireTimers()
    expect(h.playChime).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith({
      kind: 'attention', terminalId: 't1', title: 'Claude Code needs your input', detail: 'my pane', at: 5000
    })
  })

  it('does not record a resolved fact or a pane the user is watching', () => {
    const record = vi.fn()
    startNotificationWatch({ ...h.deps, record })
    h.emit({ t1: s('blocked') }, { t1: s('working') })
    h.states.current = { t1: s('working') }
    h.fireTimers()
    h.emit({ t2: s('idle', false) }, { t2: s('working') })
    h.focus.watchedId = 't2'
    h.fireTimers()
    expect(record).not.toHaveBeenCalled()
  })

  it('records a long finished command with its command copy', () => {
    const record = vi.fn()
    startNotificationWatch({ ...h.deps, record })
    const last = fin(60_000, 1)
    h.emitCommands({ sh1: cmd('prompt', last) }, { sh1: cmd('running') })
    h.fireTimers()
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toMatchObject({ kind: 'command', terminalId: 'sh1' })
  })
})

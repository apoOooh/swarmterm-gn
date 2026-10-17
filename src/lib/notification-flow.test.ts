import { describe, expect, it } from 'vitest'
import type { AgentPaneState } from '@/lib/agent-state/rollup'
import type { CommandState, FinishedCommand } from '@/lib/shell-marks'
import { diffAgentStates, diffCommands, diffWatchedCompletions } from './notification-flow'
import { coalesceNotifications, isStillHeld, notificationCopy, resolveFire } from './notification-flow'

const s = (state: AgentPaneState['state'], seen = true): AgentPaneState => ({ state, seen, sinceMs: 0 })
const fin = (durationMs: number, exitCode?: number): FinishedCommand => ({
  startedAt: 100_000,
  finishedAt: 100_000 + durationMs,
  durationMs,
  ...(exitCode === undefined ? {} : { exitCode })
})
const cmd = (phase: CommandState['phase'], last?: FinishedCommand): CommandState =>
  last === undefined ? { phase } : { phase, last }

describe('diffAgentStates', () => {
  it('returns nothing for identical records', () => {
    const a = { t1: s('working') }
    expect(diffAgentStates(a, a)).toEqual([])
    expect(diffAgentStates({}, {})).toEqual([])
  })

  it('reports attention when a pane enters blocked', () => {
    expect(diffAgentStates({ t1: s('working') }, { t1: s('blocked') })).toEqual([
      { terminalId: 't1', kind: 'attention' }
    ])
  })

  it('reports attention for a previously absent entry that is blocked', () => {
    expect(diffAgentStates({}, { t1: s('blocked') })).toEqual([{ terminalId: 't1', kind: 'attention' }])
  })

  it('does not re-report attention while blocked persists (new object, same state)', () => {
    expect(diffAgentStates({ t1: s('blocked') }, { t1: s('blocked') })).toEqual([])
  })

  it('reports completion for working→idle landing unseen', () => {
    expect(diffAgentStates({ t1: s('working') }, { t1: s('idle', false) })).toEqual([
      { terminalId: 't1', kind: 'completion' }
    ])
  })

  it('reports completion for blocked→idle landing unseen', () => {
    expect(diffAgentStates({ t1: s('blocked') }, { t1: s('idle', false) })).toEqual([
      { terminalId: 't1', kind: 'completion' }
    ])
  })

  it('ignores a watched completion (seen stays true)', () => {
    expect(diffAgentStates({ t1: s('working') }, { t1: s('idle', true) })).toEqual([])
  })

  it('ignores unknown→idle (spawn settling) and absent→idle', () => {
    expect(diffAgentStates({ t1: s('unknown') }, { t1: s('idle', false) })).toEqual([])
    expect(diffAgentStates({}, { t1: s('idle', false) })).toEqual([])
  })

  it('ignores the markSeen flip (idle unseen → idle seen)', () => {
    expect(diffAgentStates({ t1: s('idle', false) }, { t1: s('idle', true) })).toEqual([])
  })

  it('reports removed when an entry disappears', () => {
    expect(diffAgentStates({ t1: s('working') }, {})).toEqual([{ terminalId: 't1', kind: 'removed' }])
  })

  it('handles several panes in one update', () => {
    const prev = { t1: s('working'), t2: s('idle'), t3: s('working') }
    const next = { t1: s('blocked'), t2: s('idle') }
    expect(diffAgentStates(prev, next)).toEqual([
      { terminalId: 't1', kind: 'attention' },
      { terminalId: 't3', kind: 'removed' }
    ])
  })
})

describe('diffCommands', () => {
  it('returns nothing for identical records or entries without a finished command', () => {
    const a = { sh1: cmd('running') }
    expect(diffCommands(a, a)).toEqual([])
    expect(diffCommands({}, { sh1: cmd('prompt') })).toEqual([])
  })

  it('reports a command when a new long `last` lands (D mark), including a previously absent entry', () => {
    const L = fin(12_000, 1)
    expect(diffCommands({ sh1: cmd('running') }, { sh1: cmd('finished', L) })).toEqual([
      { terminalId: 'sh1', kind: 'command', last: L }
    ])
    expect(diffCommands({}, { sh1: cmd('finished', L) })).toEqual([{ terminalId: 'sh1', kind: 'command', last: L }])
  })

  it('ignores a short command', () => {
    expect(diffCommands({ sh1: cmd('running') }, { sh1: cmd('finished', fin(9_999)) })).toEqual([])
  })

  it('ignores the prompt redraw that carries the same `last` by reference (D and A share a precmd)', () => {
    const L = fin(12_000)
    expect(diffCommands({ sh1: cmd('finished', L) }, { sh1: cmd('prompt', L) })).toEqual([])
    expect(diffCommands({ sh1: cmd('prompt', L) }, { sh1: cmd('running', L) })).toEqual([])
  })

  it('reports removed when an entry disappears (exit/respawn clear)', () => {
    expect(diffCommands({ sh1: cmd('prompt', fin(12_000)) }, {})).toEqual([{ terminalId: 'sh1', kind: 'removed' }])
  })
})

const basePrefs = { sound: true, system: true, perAgent: {} }
const pend = (kind: 'attention' | 'completion') => ({ terminalId: 't1', kind, agentId: 'claude-code' })
const ctx = (over: Partial<Parameters<typeof resolveFire>[1]>) => ({
  current: s('blocked'),
  paneWatched: false,
  windowFocused: true,
  prefs: basePrefs,
  ...over
})

describe('resolveFire', () => {
  it('drops when the entry is gone (terminal died/respawned)', () => {
    expect(resolveFire(pend('attention'), ctx({ current: undefined }))).toEqual({ sound: false, system: false })
  })

  it('drops attention when the pane is no longer blocked', () => {
    expect(resolveFire(pend('attention'), ctx({ current: s('working') }))).toEqual({ sound: false, system: false })
  })

  it('drops completion when the pane left idle or was seen', () => {
    expect(resolveFire(pend('completion'), ctx({ current: s('working') }))).toEqual({ sound: false, system: false })
    expect(resolveFire(pend('completion'), ctx({ current: s('idle', true) }))).toEqual({ sound: false, system: false })
  })

  it('fires completion while still idle-unseen', () => {
    expect(resolveFire(pend('completion'), ctx({ current: s('idle', false) }))).toEqual({ sound: true, system: false })
  })

  it('drops when the pane became watched during the delay', () => {
    expect(resolveFire(pend('attention'), ctx({ paneWatched: true }))).toEqual({ sound: false, system: false })
  })

  it('chimes without a banner while the window is focused', () => {
    expect(resolveFire(pend('attention'), ctx({ windowFocused: true }))).toEqual({ sound: true, system: false })
  })

  it('adds the banner when the window is unfocused', () => {
    expect(resolveFire(pend('attention'), ctx({ windowFocused: false }))).toEqual({ sound: true, system: true })
  })

  it('respects the channel toggles independently', () => {
    expect(
      resolveFire(pend('attention'), ctx({ windowFocused: false, prefs: { ...basePrefs, sound: false } }))
    ).toEqual({ sound: false, system: true })
    expect(
      resolveFire(pend('attention'), ctx({ windowFocused: false, prefs: { ...basePrefs, system: false } }))
    ).toEqual({ sound: true, system: false })
  })

  it('drops entirely when the per-agent toggle is off', () => {
    expect(
      resolveFire(pend('attention'), ctx({ windowFocused: false, prefs: { ...basePrefs, perAgent: { 'claude-code': false } } }))
    ).toEqual({ sound: false, system: false })
  })
})

describe('resolveFire — command', () => {
  const L = fin(12_000, 1)
  const pendC = (finishedAt: number | null = L.finishedAt) => ({
    terminalId: 'sh1',
    kind: 'command' as const,
    agentId: 'terminal',
    ...(finishedAt === null ? {} : { finishedAt })
  })
  const ctxC = (over: Partial<Parameters<typeof resolveFire>[1]>) =>
    ctx({ current: undefined, command: cmd('prompt', L), ...over })

  it('fires on the matching `last` even though the pane has no agent state and is already back at the prompt', () => {
    expect(resolveFire(pendC(), ctxC({}))).toEqual({ sound: true, system: false })
    expect(resolveFire(pendC(), ctxC({ windowFocused: false }))).toEqual({ sound: true, system: true })
  })

  it('drops when the entry is gone, when a newer command replaced `last`, or when the pending carries no finishedAt', () => {
    expect(resolveFire(pendC(), ctxC({ command: undefined }))).toEqual({ sound: false, system: false })
    expect(resolveFire(pendC(), ctxC({ command: cmd('prompt', fin(3_000)) }))).toEqual({ sound: false, system: false })
    expect(resolveFire(pendC(), ctxC({ command: cmd('running') }))).toEqual({ sound: false, system: false })
    expect(resolveFire(pendC(null), ctxC({}))).toEqual({ sound: false, system: false })
  })

  it('drops a watched pane and honours the Terminal per-agent toggle', () => {
    expect(resolveFire(pendC(), ctxC({ paneWatched: true }))).toEqual({ sound: false, system: false })
    expect(
      resolveFire(pendC(), ctxC({ prefs: { ...basePrefs, perAgent: { terminal: false } } }))
    ).toEqual({ sound: false, system: false })
  })
})

describe('notificationCopy', () => {
  it('phrases attention and completion with the agent display name', () => {
    expect(notificationCopy('attention', 'Claude Code', 'fix tests')).toEqual({
      title: 'Claude Code needs your input',
      body: 'fix tests'
    })
    expect(notificationCopy('completion', 'Codex', '')).toEqual({ title: 'Codex finished', body: '' })
  })

  it('phrases a command with its exit/duration and falls back without a record', () => {
    expect(notificationCopy('command', 'Terminal', 'build', fin(42_000, 1))).toEqual({
      title: 'Command failed (exit 1 · 42s)',
      body: 'build'
    })
    expect(notificationCopy('command', 'Terminal', 'build', fin(42_000))).toEqual({
      title: 'Command finished (42s)',
      body: 'build'
    })
    expect(notificationCopy('command', 'Terminal', '')).toEqual({ title: 'Command finished', body: '' })
  })
})

describe('coalesceNotifications', () => {
  const f = (kind: 'attention' | 'completion', agentName: string, paneTitle: string) => ({ kind, agentName, paneTitle })
  const fc = (paneTitle: string, last: FinishedCommand) => ({
    kind: 'command' as const,
    agentName: 'Terminal',
    paneTitle,
    command: last
  })

  it('a single command is byte-identical to notificationCopy with its record', () => {
    const L = fin(12_000, 2)
    expect(coalesceNotifications([fc('build', L)])).toEqual({
      kind: 'command',
      ...notificationCopy('command', 'Terminal', 'build', L)
    })
  })

  it('groups several commands as "<n> commands finished"', () => {
    expect(coalesceNotifications([fc('a', fin(12_000)), fc('b', fin(15_000, 1))])).toEqual({
      kind: 'command',
      title: '2 commands finished',
      body: 'a · b'
    })
  })

  it('commands rank below agents for the tone and come last in the copy', () => {
    expect(
      coalesceNotifications([fc('build', fin(12_000)), f('completion', 'Codex', 'c'), f('attention', 'Claude Code', 'a')])
    ).toEqual({
      kind: 'attention',
      title: 'Claude Code needs your input · Codex finished · Command finished (12s)',
      body: 'a · c · build'
    })
    expect(coalesceNotifications([fc('build', fin(12_000)), f('completion', 'Codex', 'c')])).toEqual({
      kind: 'completion',
      title: 'Codex finished · Command finished (12s)',
      body: 'c · build'
    })
  })

  it('returns null for an empty batch', () => {
    expect(coalesceNotifications([])).toBeNull()
  })

  it("a single entry is byte-identical to notificationCopy (today's banners unchanged)", () => {
    expect(coalesceNotifications([f('attention', 'Claude Code', 'fix tests')])).toEqual({
      kind: 'attention',
      ...notificationCopy('attention', 'Claude Code', 'fix tests')
    })
    expect(coalesceNotifications([f('completion', 'Codex', '')])).toEqual({
      kind: 'completion',
      title: 'Codex finished',
      body: ''
    })
  })

  it('groups same-agent completions as "<n> <name> panes finished"', () => {
    expect(coalesceNotifications([f('completion', 'Claude Code', 'a'), f('completion', 'Claude Code', 'b')])).toEqual({
      kind: 'completion',
      title: '2 Claude Code panes finished',
      body: 'a · b'
    })
  })

  it('groups mixed-agent completions as "<n> agents finished"', () => {
    expect(coalesceNotifications([f('completion', 'Claude Code', 'a'), f('completion', 'Codex', 'b')])).toEqual({
      kind: 'completion',
      title: '2 agents finished',
      body: 'a · b'
    })
  })

  it('attention outranks completion and is listed first regardless of input order', () => {
    expect(coalesceNotifications([f('completion', 'Codex', 'build'), f('attention', 'Claude Code', 'review')])).toEqual({
      kind: 'attention',
      title: 'Claude Code needs your input · Codex finished',
      body: 'review · build'
    })
  })

  it('pluralises attention as "<n> agents need your input" and keeps the completion segment', () => {
    expect(
      coalesceNotifications([
        f('attention', 'Claude Code', 'a'),
        f('completion', 'Codex', 'c'),
        f('attention', 'Codex', 'b')
      ])
    ).toEqual({
      kind: 'attention',
      title: '2 agents need your input · Codex finished',
      body: 'a · b · c'
    })
  })

  it('pluralises same-agent attention as "<n> <name> panes need your input"', () => {
    expect(coalesceNotifications([f('attention', 'Claude Code', 'a'), f('attention', 'Claude Code', 'b')])).toEqual({
      kind: 'attention',
      title: '2 Claude Code panes need your input',
      body: 'a · b'
    })
  })

  it('drops empty pane titles from a grouped body', () => {
    expect(coalesceNotifications([f('completion', 'Codex', ''), f('completion', 'Codex', 'b'), f('completion', 'Codex', '')])).toEqual({
      kind: 'completion',
      title: '3 Codex panes finished',
      body: 'b'
    })
  })
})

describe('isStillHeld (SWA-58)', () => {
  const st = (state: 'idle' | 'blocked' | 'working', seen: boolean) => ({ state, seen, sinceMs: 0 })
  it('holds a seen idle or blocked fact, never a command or a moved-on pane', () => {
    expect(isStillHeld({ terminalId: 't', kind: 'completion', agentId: 'claude-code' }, { current: st('idle', true) })).toBe(true)
    expect(isStillHeld({ terminalId: 't', kind: 'attention', agentId: 'claude-code' }, { current: st('blocked', true) })).toBe(true)
    expect(isStillHeld({ terminalId: 't', kind: 'completion', agentId: 'claude-code' }, { current: st('working', true) })).toBe(false)
    expect(isStillHeld({ terminalId: 't', kind: 'completion', agentId: 'claude-code' }, { current: undefined })).toBe(false)
    expect(isStillHeld({ terminalId: 't', kind: 'command', agentId: 'terminal', finishedAt: 1 }, { current: st('idle', false) })).toBe(false)
  })
})

describe('diffWatchedCompletions (SWA-58)', () => {
  const st = (state: 'idle' | 'blocked' | 'working', seen: boolean) => ({ state, seen, sinceMs: 0 })
  it('lists idle-and-seen panes that just stopped working, nothing else', () => {
    expect(diffWatchedCompletions(
      { a: st('working', true), b: st('working', true), c: st('idle', true), d: st('blocked', true) },
      { a: st('idle', true), b: st('idle', false), c: st('idle', true), d: st('idle', true) }
    )).toEqual(['a', 'd'])
  })
})

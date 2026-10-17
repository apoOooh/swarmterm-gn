import { describe, expect, it } from 'vitest'
import {
  decideRun,
  describeSchedule,
  GRACE_MS,
  latestSlot,
  MAX_ROUTINES,
  nextSlot,
  parseRoutines,
  removeRoutine,
  serializeRoutines,
  upsertRoutine,
  validateRoutine,
  type Routine,
  type RoutineSchedule
} from './routines'

const MIN = 60_000
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'r1',
    name: 'Nightly',
    enabled: true,
    kind: 'agent',
    agentId: 'claude-code',
    brief: 'Review open PRs',
    worktree: false,
    schedule: { kind: 'interval', everyMinutes: 60 },
    missed: 'run-once',
    lastScheduledAt: at(2026, 10, 12, 8),
    ...over
  }
}

describe('validateRoutine', () => {
  it('accepts a sane routine', () => expect(validateRoutine(routine())).toBeNull())
  it('rejects empty name, brief and agent', () => {
    expect(validateRoutine(routine({ name: '  ' }))).toMatch(/name/)
    expect(validateRoutine(routine({ brief: ' ' }))).toMatch(/brief/)
    expect(validateRoutine(routine({ agentId: '' }))).toMatch(/agent/)
  })
  it('bounds the interval', () => {
    expect(validateRoutine(routine({ schedule: { kind: 'interval', everyMinutes: 4 } }))).toMatch(/interval/)
    expect(validateRoutine(routine({ schedule: { kind: 'interval', everyMinutes: 7.5 } }))).toMatch(/interval/)
  })
  it('checks time and weekdays', () => {
    expect(validateRoutine(routine({ schedule: { kind: 'daily', time: '24:00', weekdays: [] } }))).toMatch(/time/)
    expect(validateRoutine(routine({ schedule: { kind: 'daily', time: '9:30', weekdays: [] } }))).toMatch(/time/)
    expect(validateRoutine(routine({ schedule: { kind: 'daily', time: '09:30', weekdays: [7] } }))).toMatch(/weekday/i)
    expect(validateRoutine(routine({ schedule: { kind: 'daily', time: '09:30', weekdays: [1, 5] } }))).toBeNull()
  })
})

describe('latestSlot / nextSlot — interval', () => {
  const s = { kind: 'interval', everyMinutes: 60 } as const
  const anchor = at(2026, 10, 12, 8)
  it('has no slot before one interval passed', () => expect(latestSlot(s, anchor, anchor + 59 * MIN)).toBeUndefined())
  it('returns the grid point, not now', () => expect(latestSlot(s, anchor, anchor + 61 * MIN)).toBe(anchor + 60 * MIN))
  it('collapses many missed slots into the latest', () => expect(latestSlot(s, anchor, anchor + 10 * 60 * MIN + 5 * MIN)).toBe(anchor + 600 * MIN))
  it('next slot follows the grid', () => expect(nextSlot(s, anchor, anchor + 61 * MIN)).toBe(anchor + 120 * MIN))
})

describe('latestSlot / nextSlot — daily', () => {
  // 2026-10-12 is a Monday.
  const s = { kind: 'daily', time: '09:30', weekdays: [] as number[] } as const
  it('finds today once the time passed', () => expect(latestSlot(s, at(2026, 10, 12, 0), at(2026, 10, 12, 9, 31))).toBe(at(2026, 10, 12, 9, 30)))
  it('none before the time when the anchor is today', () => expect(latestSlot(s, at(2026, 10, 12, 0), at(2026, 10, 12, 9, 29))).toBeUndefined())
  it('falls back to yesterday', () => expect(latestSlot(s, at(2026, 10, 10), at(2026, 10, 12, 8))).toBe(at(2026, 10, 11, 9, 30)))
  it('respects weekdays across a week boundary', () => {
    const fri: RoutineSchedule = { kind: 'daily', time: '18:00', weekdays: [5] }
    expect(latestSlot(fri, at(2026, 10, 1), at(2026, 10, 12, 8))).toBe(at(2026, 10, 9, 18))
    expect(nextSlot(fri, 0, at(2026, 10, 12, 8))).toBe(at(2026, 10, 16, 18))
  })
  it('ignores slots at or before the anchor', () => expect(latestSlot(s, at(2026, 10, 12, 9, 30), at(2026, 10, 12, 10))).toBeUndefined())
  it('next slot is tomorrow once today passed', () => expect(nextSlot(s, 0, at(2026, 10, 12, 10))).toBe(at(2026, 10, 13, 9, 30)))
  it('keeps local wall time over the DST change', () => {
    // Europe: clocks go back on 2026-10-25; local 09:30 stays 09:30.
    const slot = latestSlot(s, at(2026, 10, 24), at(2026, 10, 26, 10))!
    expect(new Date(slot).getHours()).toBe(9)
    expect(new Date(slot).getMinutes()).toBe(30)
  })
})

describe('decideRun', () => {
  const base = routine()
  const onTime = base.lastScheduledAt + 60 * MIN + 10_000
  it('does nothing when disabled or not due', () => {
    expect(decideRun(routine({ enabled: false }), onTime, false)).toEqual({ action: 'none' })
    expect(decideRun(base, base.lastScheduledAt + 30 * MIN, false)).toEqual({ action: 'none' })
  })
  it('runs a due slot on time', () => expect(decideRun(base, onTime, false)).toEqual({ action: 'run', slot: base.lastScheduledAt + 60 * MIN, catchUp: false }))
  it('drops the slot while the previous run is busy', () =>
    expect(decideRun(base, onTime, true)).toEqual({ action: 'skip', slot: base.lastScheduledAt + 60 * MIN, reason: 'overlap' }))
  it('catches up once after the app was away', () => {
    const late = at(2026, 10, 12, 20) + GRACE_MS + 1
    expect(decideRun(base, late, false)).toEqual({ action: 'run', slot: at(2026, 10, 12, 20), catchUp: true })
  })
  it('skips a missed slot when asked to', () => {
    const late = at(2026, 10, 12, 20) + GRACE_MS + 1
    expect(decideRun(routine({ missed: 'skip' }), late, false)).toEqual({ action: 'skip', slot: at(2026, 10, 12, 20), reason: 'missed' })
  })
  it('consuming the slot stops a repeat on the next tick', () => {
    const d = decideRun(base, onTime, false)
    if (d.action !== 'run') throw new Error('expected run')
    expect(decideRun({ ...base, lastScheduledAt: d.slot }, onTime + 30_000, false)).toEqual({ action: 'none' })
  })
})

describe('list + persistence', () => {
  it('upserts, caps and removes', () => {
    const a = upsertRoutine([], routine({ id: 'a', name: ' A ' }))
    expect(a[0].name).toBe('A')
    expect(upsertRoutine(a, routine({ id: 'a', name: 'B' }))[0].name).toBe('B')
    const full = Array.from({ length: MAX_ROUTINES }, (_, i) => routine({ id: `x${i}` }))
    expect(upsertRoutine(full, routine({ id: 'new' }))).toBe(full)
    expect(removeRoutine(a, 'a')).toEqual([])
  })
  it('round-trips without the live pane id', () => {
    const r = routine({ activeTerminalId: 't1', lastRunAt: 5, accountId: 'acc', schedule: { kind: 'daily', time: '07:00', weekdays: [1] } })
    const back = parseRoutines(serializeRoutines([r]))
    const { activeTerminalId: _live, ...persisted } = r
    expect(back).toEqual([persisted])
  })
  it('drops garbage and invalid entries', () => {
    expect(parseRoutines('nope')).toEqual([])
    expect(parseRoutines(JSON.stringify({ version: 2, routines: [] }))).toEqual([])
    expect(parseRoutines(JSON.stringify({ version: 1, routines: [{ id: 'x' }, { ...routine(), brief: '' }] }))).toEqual([])
  })
})

describe('describeSchedule', () => {
  it('reads naturally', () => {
    expect(describeSchedule({ kind: 'interval', everyMinutes: 90 })).toBe('every 90 minutes')
    expect(describeSchedule({ kind: 'interval', everyMinutes: 120 })).toBe('every 2 hours')
    expect(describeSchedule({ kind: 'daily', time: '09:30', weekdays: [] })).toBe('daily at 09:30')
    expect(describeSchedule({ kind: 'daily', time: '09:30', weekdays: [5, 1] })).toBe('Mon, Fri at 09:30')
  })
})

describe('command routines', () => {
  const cmd = (over: Partial<Routine> = {}): Routine =>
    routine({ kind: 'command', agentId: '', brief: '', command: 'python refresh.py', cwd: 'C:/work', timeoutMinutes: 5, ...over })

  it('validate the line, folder and time limit instead of agent and brief', () => {
    expect(validateRoutine(cmd())).toBeNull()
    expect(validateRoutine(cmd({ command: ' ' }))).toMatch(/command is empty/)
    expect(validateRoutine(cmd({ command: 'a' + String.fromCharCode(10) + 'b' }))).toMatch(/one line/)
    expect(validateRoutine(cmd({ cwd: '' }))).toMatch(/working folder/)
    expect(validateRoutine(cmd({ timeoutMinutes: 0 }))).toMatch(/time limit/)
    expect(validateRoutine(cmd({ timeoutMinutes: 61 }))).toMatch(/time limit/)
  })
  it('round-trip, and lists from before SWA-67 load as agent routines', () => {
    const c = cmd({ lastResult: 'exit 0 · 1.0 s', worktree: false })
    expect(parseRoutines(serializeRoutines([c]))).toEqual([c])
    const { kind: _k, ...old } = routine()
    expect(parseRoutines(JSON.stringify({ version: 1, routines: [old] }))[0].kind).toBe('agent')
  })
  it('never carries the worktree flag', () => {
    expect(parseRoutines(serializeRoutines([cmd({ worktree: true })]))[0].worktree).toBe(false)
  })
})

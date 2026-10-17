/**
 * Routines (SWA-24): a named agent, a brief and a schedule — "agent mode
 * light". Pure rules only; the scheduler in App ticks them while the app runs.
 *
 * Deliberate limits:
 * - Nothing runs while the app is closed. On the next tick only the LATEST
 *   missed slot counts, so a laptop that slept through twenty slots starts at
 *   most one run (or none, with `missed: 'skip'`) — never a catch-up storm.
 * - No overlap per routine: while the previous run's agent is still working
 *   (or waiting for the user), the slot is dropped, not queued.
 * - A slot is consumed whatever the outcome (run, skip, overlap), so a
 *   decision is never repeated on the next tick.
 *
 * Command routines (SWA-67) share all of that but start no agent: one shell
 * line runs in the background (no pane, no tokens) and its exit code and
 * output tail come back. The line is typed by the user in the dialog and
 * stored only here — no MCP tool or War Room message can create one.
 */

export type RoutineSchedule =
  | { kind: 'interval'; everyMinutes: number }
  /** `weekdays` uses Date#getDay (0 = Sunday); empty means every day. */
  | { kind: 'daily'; time: string; weekdays: number[] }

export type MissedPolicy = 'run-once' | 'skip'

export type RoutineKind = 'agent' | 'command'

export interface Routine {
  id: string
  name: string
  enabled: boolean
  /** Missing in lists saved before SWA-67: those are agent routines. */
  kind: RoutineKind
  /** Agent routines only (empty for commands). */
  agentId: string
  accountId?: string
  /** Brief text sent as the agent's start argument. */
  brief: string
  worktree: boolean
  /** Command routines: one shell line, its working folder and time limit. */
  command?: string
  cwd?: string
  timeoutMinutes?: number
  /** Short outcome of the last command run ("exit 0 · 2 s"), shown in the dialog. */
  lastResult?: string
  schedule: RoutineSchedule
  missed: MissedPolicy
  /** Last slot that was decided (run, skipped or dropped); anchors the next one. */
  lastScheduledAt: number
  lastRunAt?: number
  /** Pane of the last run, for the overlap check. */
  activeTerminalId?: string
}

export const MAX_ROUTINES = 50
export const MIN_INTERVAL_MINUTES = 5
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60
export const DEFAULT_TIMEOUT_MINUTES = 5
export const MAX_TIMEOUT_MINUTES = 60
/** Same bound as the backend (`routine_cmd::MAX_COMMAND_CHARS`). */
export const MAX_COMMAND_CHARS = 4000
/** A slot found within this window of its time counts as on time, not missed. */
export const GRACE_MS = 2 * 60_000
const MAX_NAME_CHARS = 80
const MAX_BRIEF_CHARS = 20_000
const MINUTE = 60_000

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function parseTime(time: string): { h: number; m: number } | undefined {
  const m = TIME_RE.exec(time)
  return m ? { h: Number(m[1]), m: Number(m[2]) } : undefined
}

export function validateRoutine(
  r: Pick<Routine, 'name' | 'brief' | 'agentId' | 'schedule'> & Partial<Pick<Routine, 'kind' | 'command' | 'cwd' | 'timeoutMinutes'>>
): string | null {
  const name = r.name.trim()
  if (!name || name.length > MAX_NAME_CHARS) return `Give the routine a name (up to ${MAX_NAME_CHARS} characters).`
  if (r.kind === 'command') {
    const c = (r.command ?? '').trim()
    if (!c) return 'The command is empty.'
    if (c.length > MAX_COMMAND_CHARS || /[\r\n]/.test(c)) return `The command must be one line (max ${MAX_COMMAND_CHARS} characters).`
    if (!(r.cwd ?? '').trim()) return 'Choose a working folder.'
    const t = r.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES
    if (!Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_MINUTES) return `The time limit must be whole minutes between 1 and ${MAX_TIMEOUT_MINUTES}.`
  } else {
    if (!r.agentId) return 'Choose an agent.'
    if (!r.brief.trim()) return 'The brief is empty.'
    if (r.brief.length > MAX_BRIEF_CHARS) return `The brief is too long (max ${MAX_BRIEF_CHARS} characters).`
  }
  const s = r.schedule
  if (s.kind === 'interval') {
    if (!Number.isInteger(s.everyMinutes) || s.everyMinutes < MIN_INTERVAL_MINUTES || s.everyMinutes > MAX_INTERVAL_MINUTES)
      return `The interval must be whole minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`
  } else {
    if (!parseTime(s.time)) return 'The time must look like 09:30.'
    if (s.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Invalid weekday.'
  }
  return null
}

/** Slot of a daily schedule on the calendar day of `day` (local time), if that weekday is active. */
function dailySlot(schedule: Extract<RoutineSchedule, { kind: 'daily' }>, day: Date): number | undefined {
  const t = parseTime(schedule.time)
  if (!t) return undefined
  if (schedule.weekdays.length > 0 && !schedule.weekdays.includes(day.getDay())) return undefined
  // setHours keeps local wall time across DST; a skipped hour shifts forward.
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.h, t.m).getTime()
}

/** Most recent slot in (anchor, now], or undefined. */
export function latestSlot(schedule: RoutineSchedule, anchor: number, now: number): number | undefined {
  if (now <= anchor) return undefined
  if (schedule.kind === 'interval') {
    const every = schedule.everyMinutes * MINUTE
    const n = Math.floor((now - anchor) / every)
    return n >= 1 ? anchor + n * every : undefined
  }
  const today = new Date(now)
  for (let back = 0; back <= 7; back++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)
    const slot = dailySlot(schedule, day)
    if (slot !== undefined && slot <= now) return slot > anchor ? slot : undefined
  }
  return undefined
}

/** First slot strictly after `now` (for display). */
export function nextSlot(schedule: RoutineSchedule, anchor: number, now: number): number | undefined {
  if (schedule.kind === 'interval') {
    const every = schedule.everyMinutes * MINUTE
    if (now < anchor) return anchor + every
    return anchor + (Math.floor((now - anchor) / every) + 1) * every
  }
  const today = new Date(now)
  for (let ahead = 0; ahead <= 7; ahead++) {
    const slot = dailySlot(schedule, new Date(today.getFullYear(), today.getMonth(), today.getDate() + ahead))
    if (slot !== undefined && slot > now) return slot
  }
  return undefined
}

export type RunDecision =
  | { action: 'none' }
  | { action: 'run'; slot: number; catchUp: boolean }
  | { action: 'skip'; slot: number; reason: 'missed' | 'overlap' }

/**
 * What a tick does with one routine. `previousBusy` says whether the last
 * run's agent is still working or waiting for input.
 */
export function decideRun(routine: Routine, now: number, previousBusy: boolean): RunDecision {
  if (!routine.enabled) return { action: 'none' }
  const slot = latestSlot(routine.schedule, routine.lastScheduledAt, now)
  if (slot === undefined) return { action: 'none' }
  const catchUp = now - slot > GRACE_MS
  if (catchUp && routine.missed === 'skip') return { action: 'skip', slot, reason: 'missed' }
  if (previousBusy) return { action: 'skip', slot, reason: 'overlap' }
  return { action: 'run', slot, catchUp }
}

export function describeSchedule(s: RoutineSchedule): string {
  if (s.kind === 'interval') {
    const m = s.everyMinutes
    if (m % 1440 === 0) return `every ${m / 1440} day${m === 1440 ? '' : 's'}`
    if (m % 60 === 0) return `every ${m / 60} hour${m === 60 ? '' : 's'}`
    return `every ${m} minutes`
  }
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const days = s.weekdays.length === 0 || s.weekdays.length === 7 ? 'daily' : [...s.weekdays].sort().map((d) => names[d]).join(', ')
  return `${days} at ${s.time}`
}

export function upsertRoutine(list: readonly Routine[], routine: Routine): Routine[] {
  const exists = list.some((x) => x.id === routine.id)
  if (!exists && list.length >= MAX_ROUTINES) return list as Routine[]
  const clean = { ...routine, name: routine.name.trim() }
  return exists ? list.map((x) => (x.id === routine.id ? clean : x)) : [...list, clean]
}

export function removeRoutine(list: readonly Routine[], id: string): Routine[] {
  return list.filter((x) => x.id !== id)
}

export function serializeRoutines(list: readonly Routine[]): string {
  // The pane id means nothing after a restart: never persisted.
  return JSON.stringify({ version: 1, routines: list.map(({ activeTerminalId: _drop, ...r }) => r) })
}

function parseSchedule(x: unknown): RoutineSchedule | undefined {
  const s = x as Partial<{ kind: string; everyMinutes: unknown; time: unknown; weekdays: unknown }>
  if (s?.kind === 'interval' && typeof s.everyMinutes === 'number') return { kind: 'interval', everyMinutes: s.everyMinutes }
  if (s?.kind === 'daily' && typeof s.time === 'string' && Array.isArray(s.weekdays) && s.weekdays.every((d) => typeof d === 'number'))
    return { kind: 'daily', time: s.time, weekdays: s.weekdays as number[] }
  return undefined
}

/** Lenient: garbage and invalid entries are dropped, not reported. */
export function parseRoutines(raw: string | null): Routine[] {
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const d = data as { version?: unknown; routines?: unknown }
  if (d?.version !== 1 || !Array.isArray(d.routines)) return []
  const seen = new Set<string>()
  const out: Routine[] = []
  for (const x of d.routines as Partial<Routine>[]) {
    const schedule = parseSchedule(x?.schedule)
    if (typeof x?.id !== 'string' || typeof x.name !== 'string' || typeof x.brief !== 'string' || typeof x.agentId !== 'string' || !schedule) continue
    const kind: RoutineKind = x.kind === 'command' ? 'command' : 'agent'
    const r: Routine = {
      id: x.id,
      name: x.name,
      enabled: x.enabled === true,
      kind,
      agentId: x.agentId,
      ...(typeof x.accountId === 'string' ? { accountId: x.accountId } : {}),
      brief: x.brief,
      worktree: kind === 'agent' && x.worktree === true,
      ...(kind === 'command'
        ? {
            command: typeof x.command === 'string' ? x.command : '',
            cwd: typeof x.cwd === 'string' ? x.cwd : '',
            timeoutMinutes: typeof x.timeoutMinutes === 'number' ? x.timeoutMinutes : DEFAULT_TIMEOUT_MINUTES,
            ...(typeof x.lastResult === 'string' ? { lastResult: x.lastResult } : {})
          }
        : {}),
      schedule,
      missed: x.missed === 'skip' ? 'skip' : 'run-once',
      lastScheduledAt: typeof x.lastScheduledAt === 'number' ? x.lastScheduledAt : Date.now(),
      ...(typeof x.lastRunAt === 'number' ? { lastRunAt: x.lastRunAt } : {})
    }
    if (seen.has(r.id) || validateRoutine(r) !== null) continue
    seen.add(r.id)
    out.push(r)
    if (out.length >= MAX_ROUTINES) break
  }
  return out
}

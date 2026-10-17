import { decideRun, type Routine } from '@/lib/routines'

export const ROUTINE_TICK_MS = 30_000

export type StartResult = { terminalId: string; branch?: string } | { error: string }

/** Mirrors `routine_cmd::CommandOutcome` (serde camelCase). */
export interface CommandResult {
  exitCode: number | null
  timedOut: boolean
  output: string
  durationMs: number
}

export type RunResult = StartResult | { outcome: CommandResult }

export interface RoutineDeps {
  /** Whether the previous run's agent is still working or waiting for input. */
  isBusy: (terminalId: string | undefined) => boolean
  start: (routine: Routine) => Promise<StartResult>
  /** Command routines: resolves once the line has finished (or timed out). */
  runCommand: (routine: Routine) => Promise<CommandResult>
  patch: (id: string, change: Partial<Routine>) => void
  notify: (terminalId: string, title: string, detail: string) => void
}

// Starts that are still provisioning (worktree creation is async): a tick
// landing meanwhile must not start the same routine twice. A command routine
// stays in here until its line has finished — that IS its overlap guard.
const inFlight = new Set<string>()

export const isCommandRunning = (id: string): boolean => inFlight.has(id)

const seconds = (ms: number): string => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`)

/** One line for the dialog's "Last run"; a timeout reports no exit code. */
export function describeOutcome(o: CommandResult): string {
  if (o.timedOut) return `timed out after ${seconds(o.durationMs)}`
  return `exit ${o.exitCode ?? '?'} · ${seconds(o.durationMs)}`
}

/**
 * One scheduler pass. The slot is consumed BEFORE the start is awaited, so a
 * failing or slow start can never turn into a retry loop; the outcome goes to
 * the notification bell either way.
 */
export async function tickRoutines(routines: readonly Routine[], now: number, deps: RoutineDeps): Promise<void> {
  await Promise.all(
    routines.map(async (r) => {
      const command = r.kind === 'command'
      if (inFlight.has(r.id) && !command) return
      const d = decideRun(r, now, command ? inFlight.has(r.id) : deps.isBusy(r.activeTerminalId))
      if (d.action === 'none') return
      deps.patch(r.id, { lastScheduledAt: d.slot })
      if (d.action === 'skip') {
        const why = d.reason === 'overlap' ? 'skipped, previous run still busy' : 'missed while the app was away, skipped'
        deps.notify(r.activeTerminalId ?? '', `Routine "${r.name}" ${why}`, r.name)
        return
      }
      await runRoutine(r, deps, d.catchUp ? 'caught up' : 'started')
    })
  )
}

/** Also used by "Run now", which bypasses the schedule but not the overlap guard. */
export async function runRoutine(r: Routine, deps: RoutineDeps, verb = 'started'): Promise<RunResult> {
  if (inFlight.has(r.id)) return { error: r.kind === 'command' ? 'still running' : 'already starting' }
  inFlight.add(r.id)
  try {
    if (r.kind === 'command') return await runCommandRoutine(r, deps)
    const res = await deps.start(r).catch((e: unknown): StartResult => ({ error: String(e) }))
    if ('error' in res) {
      deps.notify('', `Routine "${r.name}" not started: ${res.error}`, r.name)
    } else {
      deps.patch(r.id, { lastRunAt: Date.now(), activeTerminalId: res.terminalId })
      deps.notify(res.terminalId, `Routine "${r.name}" ${verb}${res.branch ? ` in ${res.branch}` : ''}`, r.name)
    }
    return res
  } finally {
    inFlight.delete(r.id)
  }
}

/**
 * A finished command reports to the bell only when it failed or timed out:
 * a refresh every 15 minutes must not fill the bell with "ok". Success shows
 * in the dialog's "Last run" line instead.
 */
async function runCommandRoutine(r: Routine, deps: RoutineDeps): Promise<RunResult> {
  let outcome: CommandResult
  try {
    outcome = await deps.runCommand(r)
  } catch (e) {
    const error = String(e)
    deps.patch(r.id, { lastRunAt: Date.now(), lastResult: `not started: ${error}` })
    deps.notify('', `Routine "${r.name}" not started: ${error}`, r.name)
    return { error }
  }
  const result = describeOutcome(outcome)
  deps.patch(r.id, { lastRunAt: Date.now(), lastResult: result })
  if (outcome.timedOut || outcome.exitCode !== 0) {
    const last = outcome.output.split('\n').pop() ?? ''
    deps.notify('', `Routine "${r.name}" failed: ${result}`, last ? `${r.name} · ${last}` : r.name)
  }
  return { outcome }
}

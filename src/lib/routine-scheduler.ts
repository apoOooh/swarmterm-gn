import { decideRun, type Routine } from '@/lib/routines'

export const ROUTINE_TICK_MS = 30_000

export type StartResult = { terminalId: string; branch?: string } | { error: string }

export interface RoutineDeps {
  /** Whether the previous run's agent is still working or waiting for input. */
  isBusy: (terminalId: string | undefined) => boolean
  start: (routine: Routine) => Promise<StartResult>
  patch: (id: string, change: Partial<Routine>) => void
  notify: (terminalId: string, title: string, detail: string) => void
}

// Starts that are still provisioning (worktree creation is async): a tick
// landing meanwhile must not start the same routine twice.
const inFlight = new Set<string>()

/**
 * One scheduler pass. The slot is consumed BEFORE the start is awaited, so a
 * failing or slow start can never turn into a retry loop; the outcome goes to
 * the notification bell either way.
 */
export async function tickRoutines(routines: readonly Routine[], now: number, deps: RoutineDeps): Promise<void> {
  await Promise.all(
    routines.map(async (r) => {
      if (inFlight.has(r.id)) return
      const d = decideRun(r, now, deps.isBusy(r.activeTerminalId))
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
export async function runRoutine(r: Routine, deps: RoutineDeps, verb = 'started'): Promise<StartResult> {
  if (inFlight.has(r.id)) return { error: 'already starting' }
  inFlight.add(r.id)
  try {
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

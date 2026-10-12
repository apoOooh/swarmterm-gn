import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useModalFocus } from '@/components/ui/use-modal-focus'
import { handoffTargets } from '@/lib/handoff-flow'
import { runRoutine } from '@/lib/routine-scheduler'
import { describeSchedule, nextSlot, type MissedPolicy, type Routine, type RoutineSchedule } from '@/lib/routines'
import { listAvailableAgents } from '@/tauri/agents'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { selectFocusedTerminalId, useAppStore } from '@/store/app-store'
import { usePromptLibraryStore } from '@/store/prompt-library-store'
import { useRoutineStore } from '@/store/routine-store'
import { routineDeps } from './routine-runtime'

const field = 'rounded border border-input bg-background p-1.5 text-sm text-foreground'
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Draft = Omit<Routine, 'lastScheduledAt' | 'lastRunAt' | 'activeTerminalId'> & { isNew: boolean }

function emptyDraft(): Draft {
  return {
    id: crypto.randomUUID(),
    isNew: true,
    name: '',
    enabled: true,
    agentId: 'claude-code',
    brief: '',
    worktree: false,
    schedule: { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] },
    missed: 'run-once'
  }
}

const when = (t: number | undefined): string => (t === undefined ? '—' : new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }))

/**
 * Routines (SWA-24): named agent + brief + schedule. Runs only while the app
 * is open; each run starts a new pane in the active workspace and reports to
 * the notification bell. role="dialog" is what overlay-watch and
 * terminal-focus key on.
 */
export function RoutinesDialog(): React.ReactElement | null {
  const open = useRoutineStore((s) => s.open)
  const routines = useRoutineStore((s) => s.routines)
  const error = useRoutineStore((s) => s.error)
  const prompts = usePromptLibraryStore((s) => s.prompts)
  const accounts = useAgentAccountsStore((s) => s.accounts)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [available, setAvailable] = useState<ReadonlySet<string> | undefined>()

  const close = (): void => useRoutineStore.getState().setOpen(false)
  const root = useModalFocus(open, close, open ? selectFocusedTerminalId(useAppStore.getState()) : undefined)

  useEffect(() => {
    if (!open) return
    setStatus(null)
    setConfirmDelete(false)
    let alive = true
    listAvailableAgents()
      .then((list) => alive && setAvailable(new Set(list.filter((a) => a.available).map((a) => a.id))))
      .catch(() => alive && setAvailable(new Set()))
    return () => {
      alive = false
    }
  }, [open])

  if (!open) return null
  const agents = handoffTargets(accounts, available)
  const key = (t: { agentId: string; accountId?: string }): string => `${t.agentId}:${t.accountId ?? ''}`
  const saved = routines.find((r) => r.id === draft.id)
  const now = Date.now()

  const pick = (r: Routine): void => {
    setDraft({ id: r.id, isNew: false, name: r.name, enabled: r.enabled, agentId: r.agentId, accountId: r.accountId, brief: r.brief, worktree: r.worktree, schedule: r.schedule, missed: r.missed })
    setConfirmDelete(false)
    setStatus(null)
  }
  const save = (): void => {
    const { isNew: _n, ...rest } = draft
    const ok = useRoutineStore.getState().save({ ...rest, lastScheduledAt: saved?.lastScheduledAt ?? Date.now(), lastRunAt: saved?.lastRunAt })
    if (ok) {
      setDraft({ ...draft, isNew: false })
      setStatus('Saved.')
    }
  }
  const remove = (): void => {
    if (!saved) return
    if (!confirmDelete) return setConfirmDelete(true)
    useRoutineStore.getState().remove(saved.id)
    setDraft(emptyDraft())
    setConfirmDelete(false)
  }
  const runNow = async (): Promise<void> => {
    if (!saved) return
    if (routineDeps.isBusy(saved.activeTerminalId)) return setStatus('The previous run is still busy.')
    const res = await runRoutine(saved, routineDeps)
    setStatus('error' in res ? `Not started: ${res.error}` : 'Started.')
  }
  const setSchedule = (s: RoutineSchedule): void => setDraft({ ...draft, schedule: s })
  const s = draft.schedule

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={close}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label="Routines"
        className="theme-elevated flex h-[620px] max-h-[90vh] w-[900px] max-w-[94vw] gap-3 overflow-hidden rounded-lg border border-border bg-card p-3 text-sm text-foreground shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex w-64 shrink-0 flex-col gap-2">
          <div className="font-medium">Routines</div>
          <div role="listbox" aria-label="Routines" className="flex-1 overflow-y-auto rounded border border-border">
            {routines.length === 0 && <div className="p-2 text-xs text-muted-foreground">No routines yet.</div>}
            {routines.map((r) => (
              <div
                key={r.id}
                role="option"
                aria-selected={r.id === draft.id}
                tabIndex={0}
                onClick={() => pick(r)}
                onKeyDown={(e) => e.key === 'Enter' && pick(r)}
                className={`cursor-pointer px-2 py-1 text-xs hover:bg-accent ${r.id === draft.id ? 'bg-accent' : ''}`}
              >
                <div className={`truncate ${r.enabled ? '' : 'text-muted-foreground line-through'}`}>{r.name}</div>
                <div className="truncate text-muted-foreground">
                  {describeSchedule(r.schedule)}
                  {r.enabled && ` · next ${when(nextSlot(r.schedule, r.lastScheduledAt, now))}`}
                </div>
              </div>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => { setDraft(emptyDraft()); setConfirmDelete(false); setStatus(null) }}>
            New routine
          </Button>
          <div className="text-[11px] text-muted-foreground">Routines run only while Swarmterm is open, in a new pane of the active workspace.</div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
          <div className="flex gap-2">
            <input aria-label="Routine name" placeholder="Name" className={`${field} flex-1`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" aria-label="Routine enabled" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              Enabled
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Routine agent" className={field} value={key(draft)} onChange={(e) => {
              const t = agents.find((a) => key(a) === e.target.value)
              if (t) setDraft({ ...draft, agentId: t.agentId, accountId: t.accountId })
            }}>
              {!agents.some((a) => key(a) === key(draft)) && <option value={key(draft)}>{draft.agentId}</option>}
              {agents.map((t) => (
                <option key={key(t)} value={key(t)}>
                  {t.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={draft.worktree} onChange={(e) => setDraft({ ...draft, worktree: e.target.checked })} />
              In a new git worktree
            </label>
            {prompts.length > 0 && (
              <select aria-label="Insert saved prompt" className={field} value="" onChange={(e) => {
                const p = prompts.find((x) => x.id === e.target.value)
                if (p) setDraft({ ...draft, brief: p.body, name: draft.name || p.title })
              }}>
                <option value="">Use a saved prompt…</option>
                {prompts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            )}
          </div>
          <textarea
            aria-label="Routine brief"
            placeholder="Brief — what the agent should do on each run"
            className={`${field} min-h-[160px] flex-1 resize-none font-mono text-xs`}
            value={draft.brief}
            onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
          />

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <select aria-label="Schedule kind" className={field} value={s.kind} onChange={(e) =>
              setSchedule(e.target.value === 'interval' ? { kind: 'interval', everyMinutes: 60 } : { kind: 'daily', time: '09:00', weekdays: [] })
            }>
              <option value="daily">At a time of day</option>
              <option value="interval">Every N minutes</option>
            </select>
            {s.kind === 'interval' ? (
              <label className="flex items-center gap-1">
                every
                <input aria-label="Interval minutes" type="number" min={5} className={`${field} w-20`} value={s.everyMinutes} onChange={(e) => setSchedule({ kind: 'interval', everyMinutes: Number(e.target.value) })} />
                minutes
              </label>
            ) : (
              <>
                <input aria-label="Time of day" type="time" className={field} value={s.time} onChange={(e) => setSchedule({ ...s, time: e.target.value })} />
                {DAYS.map((d, i) => (
                  <label key={d} className="flex items-center gap-0.5">
                    <input
                      type="checkbox"
                      checked={s.weekdays.includes(i)}
                      onChange={(e) => setSchedule({ ...s, weekdays: e.target.checked ? [...s.weekdays, i].sort() : s.weekdays.filter((x) => x !== i) })}
                    />
                    {d}
                  </label>
                ))}
                <span>(none = every day)</span>
              </>
            )}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            If a run was missed while the app was closed or asleep:
            <select aria-label="Missed runs" className={field} value={draft.missed} onChange={(e) => setDraft({ ...draft, missed: e.target.value as MissedPolicy })}>
              <option value="run-once">run once on return</option>
              <option value="skip">skip it</option>
            </select>
          </label>
          {saved && <div className="text-xs text-muted-foreground">Last run: {when(saved.lastRunAt)}</div>}

          <div className="flex items-center gap-2 border-t border-border pt-2">
            <Button size="sm" onClick={save}>
              Save
            </Button>
            {saved && (
              <>
                <Button size="sm" variant="ghost" onClick={() => void runNow()}>
                  Run now
                </Button>
                <Button size="sm" variant="ghost" onClick={remove}>
                  {confirmDelete ? 'Confirm delete' : 'Delete'}
                </Button>
              </>
            )}
            <div role="status" className="flex-1 truncate text-xs text-muted-foreground" title={status ?? ''}>
              {error ? <span className="text-[#F14C4C]">{error}</span> : status}
            </div>
            <Button size="sm" variant="ghost" onClick={close}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

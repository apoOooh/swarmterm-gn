import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { describeUsage, handoffTargets, sessionHookGaps, limitHint, readyHint, startingHint, type HandoffPhase } from '@/lib/handoff-flow'
import { deliverHandoffBrief } from '@/lib/handoff-delivery'
import { HOLD_REASON_COPY } from '@/lib/notification-center'
import { getTerminalGeneration, getTerminalStatus, readTerminalText } from '@/lib/terminal-registry'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { useAgentStateStore } from '@/store/agent-state-store'
import { listAvailableAgents } from '@/tauri/agents'
import { useModalFocus } from '@/components/ui/use-modal-focus'
import { selectWorkspaceByTerminalId, useAppStore } from '@/store/app-store'
import { useHandoffStore } from '@/store/handoff-store'
import { useNotificationCenterStore } from '@/store/notification-center-store'
import { useTerminalTitleStore } from '@/store/terminal-title-store'

/** How often the new pane's pty status is sampled while the handoff waits on it
 *  (the registry entry only exists once the new pane has mounted). */
const STATUS_POLL_MS = 250

/**
 * Account/agent handoff (SWA-22). Pick a target CLI + profile, start it in a
 * new pane at the source pane's cwd, then — only once the pane runs and the
 * user presses Send — deliver the brief once. The source pane is never
 * touched. Mounted once at app level (see handoff-store for why).
 * role="dialog" is what overlay-watch and terminal-focus key on.
 */
export function HandoffDialog(): React.ReactElement | null {
  const { source, target, state, minimized, setTarget, dispatch, close, minimize, restore } = useHandoffStore()
  const accounts = useAgentAccountsStore((s) => s.accounts)
  const [openedAt, setOpenedAt] = useState(0)
  const [hint, setHint] = useState<string | undefined>()
  const started = useRef(false)
  // When the new pane was started, and a clock for the "not ready" hint.
  const [startedAt, setStartedAt] = useState<number | undefined>()
  const [now, setNow] = useState(0)
  // Ids of installed CLIs; undefined until the probe answers (nothing selectable yet).
  const [available, setAvailable] = useState<ReadonlySet<string> | undefined>()
  // Installed CLIs without session-hook support: hidden, with an explanation.
  const [hookless, setHookless] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (!source) return
    started.current = false
    void useAgentAccountsStore.getState().refresh()
    setOpenedAt(Date.now())
    setHint(limitHint(readTerminalText(source.terminalId, 40)))
    setAvailable(undefined)
    setStartedAt(undefined)
    let alive = true
    listAvailableAgents()
      .then((list) => {
        if (!alive) return
        setAvailable(new Set(list.filter((a) => a.available).map((a) => a.id)))
        setHookless(sessionHookGaps(list))
      })
      .catch(() => alive && setAvailable(new Set()))
    return () => {
      alive = false
    }
  }, [source])

  const terminalId = state.terminalId
  const phase = state.phase
  const waiting = phase === 'starting' || phase === 'ready'
  useEffect(() => {
    if (!terminalId || !waiting) return
    const poll = (): void => {
      const status = getTerminalStatus(terminalId)
      // The leaf leaves the layout when the pane is closed (drawered panes stay),
      // and its registry status would read `connecting` forever.
      const gone = selectWorkspaceByTerminalId(useAppStore.getState(), terminalId) === undefined
      dispatch({
        type: 'status',
        kind: gone ? 'gone' : status.kind,
        generation: getTerminalGeneration(terminalId),
        agent: useAgentStateStore.getState().byId[terminalId]?.state,
        message: status.kind === 'error' ? status.message : undefined
      })
    }
    poll()
    const h = window.setInterval(poll, STATUS_POLL_MS)
    return () => window.clearInterval(h)
  }, [terminalId, waiting, dispatch])
  // When the pane became ready, for the "Send locked" hint.
  const [readyAt, setReadyAt] = useState<number | undefined>()
  useEffect(() => {
    setReadyAt(phase === 'ready' ? Date.now() : undefined)
  }, [phase])
  useEffect(() => {
    if (phase !== 'starting' && phase !== 'ready') return
    setNow(Date.now())
    const h = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(h)
  }, [phase])

  // Failures before Send (spawn error, exit, closed pane) come from status
  // polling, not from delivery callbacks; they need the same acknowledgement.
  const error = state.error
  useEffect(() => {
    if (phase !== 'failed' || started.current || !terminalId) return
    useNotificationCenterStore.getState().add({
      kind: 'handoff',
      terminalId,
      title: `Handoff brief not sent: ${error ?? 'unknown error'}`,
      detail: useTerminalTitleStore.getState().titles[terminalId] ?? '',
      at: Date.now()
    })
  }, [phase, terminalId, error])

  const dismiss = (): void => {
    // A confirmed (possibly held) delivery keeps running after close — it is
    // the user's send. Only an unconfirmed handoff is cancelled.
    dispatch({ type: 'cancel' })
    close()
  }

  // Focus goes back to the new pane once one exists, else to the source pane.
  // Minimized = non-modal: no focus trap, and the cleanup hands focus to the
  // new pane so a trust/login prompt there can be answered.
  const root = useModalFocus(source !== undefined && !minimized, dismiss, terminalId ?? source?.terminalId)

  if (!source) return null
  const targets = available ? handoffTargets(accounts, available, hookless) : []
  const selected = target && targets.some((t) => t.agentId === target.agentId && t.accountId === target.accountId) ? target : targets[0]
  // No CLI exposes per-account usage as structured data yet, so this stays
  // "unknown" with the time it was checked — never a number scraped from text.
  const usage = describeUsage(undefined, openedAt)

  const startPane = (): void => {
    if (!selected) return
    const id = useAppStore
      .getState()
      .handoffPane(source.leafId, { agentId: selected.agentId, accountId: selected.accountId, cwd: source.cwd })
    if (id === undefined) dispatch({ type: 'failed', error: 'The source pane is gone.' })
    else {
      setStartedAt(Date.now())
      dispatch({ type: 'spawned', terminalId: id, agentId: selected.agentId })
    }
  }

  const send = (): void => {
    if (!terminalId || started.current) return
    dispatch({ type: 'confirm', live: {
        kind: getTerminalStatus(terminalId).kind,
        generation: getTerminalGeneration(terminalId),
        agent: useAgentStateStore.getState().byId[terminalId]?.state
      }
    })
    const after = useHandoffStore.getState().state
    if (after.phase !== 'delivering') return
    started.current = true
    const brief = source.brief
    // Callbacks may fire after this dialog was closed and another handoff
    // begun; they must only move THIS handoff's state.
    const mine = (event: Parameters<typeof dispatch>[0]): void => {
      if (useHandoffStore.getState().source === source) dispatch(event)
    }
    // Outcome goes to the store AND the notification center, even if this
    // dialog was closed meanwhile — the acknowledgement is per delivery.
    const acknowledge = (title: string): void =>
      useNotificationCenterStore.getState().add({
        kind: 'handoff',
        terminalId,
        title,
        detail: useTerminalTitleStore.getState().titles[terminalId] ?? '',
        at: Date.now()
      })
    deliverHandoffBrief(terminalId, after.generation, brief, {
      held: (reason) => {
        if (reason) mine({ type: 'held', reason })
      },
      pasted: (reason) => {
        mine({ type: 'pasted', reason })
        acknowledge(`Handoff brief pasted, not submitted: ${reason}`)
      },
      delivered: (at) => {
        mine({ type: 'delivered', at })
        acknowledge('Handoff brief delivered')
      },
      failed: (error) => {
        mine({ type: 'failed', error })
        acknowledge(`Handoff brief not sent: ${error}`)
      }
    })
  }

  const statusText: Record<HandoffPhase, string> = {
    choosing: 'Choose who takes over. A new pane starts in the same folder; this pane keeps running.',
    starting: 'Starting the new pane… waiting for the agent to report its session.',
    ready: state.agentSeen
      ? 'The agent in the new pane is ready. Send the brief as its first prompt?'
      : 'The agent reported its session… waiting for it to settle.',
    delivering: state.held ? `Waiting to send (${HOLD_REASON_COPY[state.held]})…` : 'Sending once the pane is quiet…',
    delivered: 'Brief delivered.',
    pasted: `Pasted, not submitted: ${state.error ?? 'something changed'}. Check the new pane and press Enter there yourself.`,
    failed: `Not sent: ${state.error ?? 'unknown error'} Copy the brief from the Handoff brief dialog instead.`,
    cancelled: 'Cancelled.'
  }
  const finished = phase === 'delivered' || phase === 'pasted' || phase === 'failed' || phase === 'delivering'
  const key = (t: { agentId: string; accountId?: string }): string => `${t.agentId}:${t.accountId ?? ''}`
  const notReady = startingHint(phase, startedAt, now) ?? readyHint(phase, state.agentSeen, readyAt, now)

  if (minimized) {
    // Non-modal chip: no role="dialog", so overlay-watch and terminal-focus
    // treat the app as unobstructed while the user works in the new pane.
    return (
      <div className="theme-elevated fixed bottom-4 right-4 z-40 flex max-w-[360px] items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground shadow-lg">
        <div role="status" className="min-w-0 flex-1">
          <div>Handoff: {phase === 'ready' ? 'agent ready, brief not sent yet' : statusText[phase]}</div>
          {notReady && <div className="mt-1 text-[#E5C07B]">{notReady}</div>}
        </div>
        <Button size="sm" variant="outline" onClick={restore}>
          Open
        </Button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={dismiss}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label="Hand off to another agent"
        className="theme-elevated flex w-[520px] max-w-[94vw] flex-col gap-3 rounded-lg border border-border bg-card p-3 text-sm text-foreground shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="font-medium">Hand off to another agent</div>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Target agent and account
          <select
            aria-label="Handoff target"
            disabled={phase !== 'choosing'}
            value={selected ? key(selected) : ''}
            onChange={(e) => {
              const t = targets.find((x) => key(x) === e.target.value)
              if (t) setTarget(t)
            }}
            className="rounded border border-input bg-background p-1.5 text-sm text-foreground"
          >
            {targets.map((t) => (
              <option key={key(t)} value={key(t)}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {hookless.has('codex') && (
          <div className="text-xs text-muted-foreground">
            Codex is not offered: this Codex version cannot report its session, so the handoff could never confirm it is ready.
          </div>
        )}
        {available && targets.length === 0 && (
          <div className="text-xs text-[#E5C07B]">No supported agent CLI (Claude Code, Codex) was found on this machine.</div>
        )}
        <div className="text-xs text-muted-foreground">
          {usage.text} (checked {new Date(usage.checkedAt).toLocaleTimeString()})
          {hint && <div className="mt-1 text-[#E5C07B]">{hint}</div>}
        </div>
        <div className="break-all text-xs text-muted-foreground">Folder: {source.cwd}</div>
        <div role="status" className="text-xs">
          {statusText[phase]}
          {notReady && <div className="mt-1 text-[#E5C07B]">{notReady}</div>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={dismiss}>
            {finished ? 'Close' : 'Cancel'}
          </Button>
          {terminalId && (phase === 'starting' || phase === 'ready' || phase === 'delivering') && (
            <Button variant="outline" size="sm" onClick={minimize}>
              Go to pane
            </Button>
          )}
          {phase === 'choosing' && (
            <Button size="sm" disabled={!selected} onClick={startPane}>
              Start pane
            </Button>
          )}
          {(phase === 'starting' || phase === 'ready') && (
            <Button size="sm" disabled={phase !== 'ready' || !state.agentSeen} onClick={send}>
              Send brief
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

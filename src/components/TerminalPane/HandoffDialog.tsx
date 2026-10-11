import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { describeUsage, handoffTargets, limitHint, type HandoffPhase } from '@/lib/handoff-flow'
import { deliverHandoffBrief } from '@/lib/handoff-delivery'
import { HOLD_REASON_COPY } from '@/lib/notification-center'
import { getTerminalGeneration, getTerminalStatus, readTerminalText } from '@/lib/terminal-registry'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { useAppStore } from '@/store/app-store'
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
  const { source, target, state, setTarget, dispatch, close } = useHandoffStore()
  const accounts = useAgentAccountsStore((s) => s.accounts)
  const [openedAt, setOpenedAt] = useState(0)
  const [hint, setHint] = useState<string | undefined>()
  const started = useRef(false)

  useEffect(() => {
    if (!source) return
    started.current = false
    void useAgentAccountsStore.getState().refresh()
    setOpenedAt(Date.now())
    setHint(limitHint(readTerminalText(source.terminalId, 40)))
  }, [source])

  const terminalId = state.terminalId
  const phase = state.phase
  const waiting = phase === 'starting' || phase === 'ready'
  useEffect(() => {
    if (!terminalId || !waiting) return
    const poll = (): void => {
      const status = getTerminalStatus(terminalId)
      dispatch({
        type: 'status',
        kind: status.kind,
        generation: getTerminalGeneration(terminalId),
        message: status.kind === 'error' ? status.message : undefined
      })
    }
    poll()
    const h = window.setInterval(poll, STATUS_POLL_MS)
    return () => window.clearInterval(h)
  }, [terminalId, waiting, dispatch])

  const dismiss = (): void => {
    // A confirmed (possibly held) delivery keeps running after close — it is
    // the user's send. Only an unconfirmed handoff is cancelled.
    dispatch({ type: 'cancel' })
    close()
  }

  useEffect(() => {
    if (!source) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!source) return null
  const targets = handoffTargets(accounts)
  const selected = target ?? targets[0]
  // No CLI exposes per-account usage as structured data yet, so this stays
  // "unknown" with the time it was checked — never a number scraped from text.
  const usage = describeUsage(undefined, openedAt)

  const startPane = (): void => {
    const id = useAppStore
      .getState()
      .handoffPane(source.leafId, { agentId: selected.agentId, accountId: selected.accountId, cwd: source.cwd })
    if (id === undefined) dispatch({ type: 'failed', error: 'The source pane is gone.' })
    else dispatch({ type: 'spawned', terminalId: id })
  }

  const send = (): void => {
    if (!terminalId || started.current) return
    dispatch({ type: 'confirm', live: { kind: getTerminalStatus(terminalId).kind, generation: getTerminalGeneration(terminalId) } })
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
    starting: 'Starting the new pane…',
    ready: 'The new pane is running. Send the brief as its first prompt?',
    delivering: state.held ? `Waiting to send (${HOLD_REASON_COPY[state.held]})…` : 'Sending once the pane is quiet…',
    delivered: 'Brief delivered.',
    failed: `Not sent: ${state.error ?? 'unknown error'} Copy the brief from the Handoff brief dialog instead.`,
    cancelled: 'Cancelled.'
  }
  const finished = phase === 'delivered' || phase === 'failed' || phase === 'delivering'
  const key = (t: { agentId: string; accountId?: string }): string => `${t.agentId}:${t.accountId ?? ''}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={dismiss}>
      <div
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
            value={key(selected)}
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
        <div className="text-xs text-muted-foreground">
          {usage.text} (checked {new Date(usage.checkedAt).toLocaleTimeString()})
          {hint && <div className="mt-1 text-[#E5C07B]">{hint}</div>}
        </div>
        <div className="break-all text-xs text-muted-foreground">Folder: {source.cwd}</div>
        <div role="status" className="text-xs">
          {statusText[phase]}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={dismiss}>
            {finished ? 'Close' : 'Cancel'}
          </Button>
          {phase === 'choosing' && (
            <Button size="sm" onClick={startPane}>
              Start pane
            </Button>
          )}
          {(phase === 'starting' || phase === 'ready') && (
            <Button size="sm" disabled={phase !== 'ready'} onClick={send}>
              Send brief
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

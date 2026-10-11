import {
  coalesceNotifications,
  diffAgentStates,
  diffCommands,
  isStillCurrent,
  notificationCopy,
  resolveFire,
  type FiredNotification,
  type NotificationKind,
  type PendingNotification
} from '@/lib/notification-flow'
import type { NotificationPrefs } from '@/lib/notification-pref'
import type { AgentPaneState } from '@/lib/agent-state/rollup'
import type { CommandState } from '@/lib/shell-marks'
import { templateById } from '@/lib/templates'

export const NOTIFY_DELAY_MS = 1000

/**
 * Entries due within this window of a firing one are flushed together. Half
 * the delay: a burst is "the same moment" from the user's side, and a late
 * joiner is still re-validated ≥ 500 ms after its own transition — longer
 * than the detector's 300 ms idle hold, so the hold's filtering is not
 * re-exposed by firing early.
 */
export const COALESCE_MS = 500

export interface NotificationWatchDeps {
  subscribeAgentStates: (
    listener: (next: Record<string, AgentPaneState>, prev: Record<string, AgentPaneState>) => void
  ) => () => void
  getAgentStates: () => Record<string, AgentPaneState>
  subscribeCommands: (
    listener: (next: Record<string, CommandState>, prev: Record<string, CommandState>) => void
  ) => () => void
  getCommandStates: () => Record<string, CommandState>
  isPaneWatched: (terminalId: string) => boolean
  isWindowFocused: () => boolean
  getAgentId: (terminalId: string) => string | undefined
  getPrefs: () => NotificationPrefs
  getPaneTitle: (terminalId: string) => string
  playChime: (kind: NotificationKind) => void
  sendSystemNotification: (opts: { title: string; body: string }) => void
  /** Notification-center feed: every still-current fact on an unwatched pane, regardless of prefs. */
  record?: (entry: { kind: NotificationKind; terminalId: string; title: string; detail: string; at: number }) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  now: () => number
}

interface Armed {
  pending: PendingNotification
  dueAt: number
  timer: unknown
}

/**
 * The impure half of agent notifications: diffs agent-state snapshots — and
 * shell-mark snapshots for plain panes (a long hand-typed command finishing),
 * both feeding the same `armed` map; an agent pane never has a shell-mark
 * entry and vice versa, so the two diffs cannot collide on an id — holds ONE
 * pending notification per terminal (a newer qualifying transition replaces
 * it — the user cares about the latest fact, not the history), and delegates
 * every decision to the pure rules in notification-flow. Timers and the clock
 * are injected so the tests never sleep, mirroring DetectorDeps.
 */
export function startNotificationWatch(deps: NotificationWatchDeps): () => void {
  const armed = new Map<string, Armed>()

  const cancel = (terminalId: string): void => {
    const cur = armed.get(terminalId)
    if (cur === undefined) return
    deps.clearTimer(cur.timer)
    armed.delete(terminalId)
  }

  const fire = (firedId: string): void => {
    // Flush the whole burst at once: N War Room panes finishing in the same
    // detector tick used to stack N chimes on the shared AudioContext and
    // N banners. The firing id is included by identity, never via the clock.
    const now = deps.now()
    const batch: PendingNotification[] = []
    for (const [id, cur] of armed) {
      if (id !== firedId && cur.dueAt > now + COALESCE_MS) continue
      deps.clearTimer(cur.timer)
      batch.push(cur.pending)
    }
    for (const p of batch) armed.delete(p.terminalId)
    // An orphan timer (its entry was flushed by an earlier batch) finds
    // nothing and is a no-op — belt and braces.
    if (batch.length === 0) return
    const states = deps.getAgentStates()
    const commands = deps.getCommandStates()
    const windowFocused = deps.isWindowFocused()
    const prefs = deps.getPrefs()
    const survivors = batch.flatMap((pending) => {
      const ctx = {
        current: states[pending.terminalId],
        command: commands[pending.terminalId],
        paneWatched: deps.isPaneWatched(pending.terminalId),
        windowFocused,
        prefs
      }
      if (deps.record !== undefined && !ctx.paneWatched && isStillCurrent(pending, ctx)) {
        const paneTitle = deps.getPaneTitle(pending.terminalId)
        const { title } = notificationCopy(
          pending.kind,
          templateById(pending.agentId).name,
          paneTitle,
          pending.kind === 'command' ? ctx.command?.last : undefined
        )
        deps.record({ kind: pending.kind, terminalId: pending.terminalId, title, detail: paneTitle, at: now })
      }
      const verdict = resolveFire(pending, ctx)
      return verdict.sound || verdict.system ? [{ pending, verdict }] : []
    })
    const group = coalesceNotifications(
      survivors.map(({ pending }): FiredNotification => {
        const base = {
          kind: pending.kind,
          agentName: templateById(pending.agentId).name,
          paneTitle: deps.getPaneTitle(pending.terminalId)
        }
        // Survived ⇒ `last` is still the record that armed us (resolveFire
        // matched its finishedAt), so it is the right one to phrase.
        const last = commands[pending.terminalId]?.last
        return pending.kind === 'command' && last !== undefined ? { ...base, command: last } : base
      })
    )
    if (group === null) return
    // The sound/system split in resolveFire is purely global (prefs + window
    // focus, read once above), so every survivor carries the same pair — one
    // coalesced result can drive both channels.
    if (survivors.some((s) => s.verdict.sound)) deps.playChime(group.kind)
    if (survivors.some((s) => s.verdict.system)) {
      deps.sendSystemNotification({ title: group.title, body: group.body })
    }
  }

  const arm = (terminalId: string, kind: NotificationKind, finishedAt?: number): void => {
    const agentId = deps.getAgentId(terminalId)
    if (agentId === undefined) return
    cancel(terminalId)
    // No explicit `finishedAt: undefined` key: the specs compare pending
    // objects structurally, and only command entries carry a finishedAt.
    const pending: PendingNotification =
      finishedAt === undefined ? { terminalId, kind, agentId } : { terminalId, kind, agentId, finishedAt }
    armed.set(terminalId, {
      pending,
      dueAt: deps.now() + NOTIFY_DELAY_MS,
      timer: deps.setTimer(() => fire(terminalId), NOTIFY_DELAY_MS)
    })
  }

  const unsubscribe = deps.subscribeAgentStates((next, prev) => {
    for (const t of diffAgentStates(prev, next)) {
      if (t.kind === 'removed') cancel(t.terminalId)
      else arm(t.terminalId, t.kind)
    }
  })

  // diffCommands already keeps only long commands and keys on the identity of
  // `last`, so a prompt redraw (D and A share a precmd) never re-arms here.
  const unsubscribeCommands = deps.subscribeCommands((next, prev) => {
    for (const t of diffCommands(prev, next)) {
      if (t.kind === 'removed') cancel(t.terminalId)
      else arm(t.terminalId, 'command', t.last.finishedAt)
    }
  })

  return () => {
    for (const id of [...armed.keys()]) cancel(id)
    unsubscribe()
    unsubscribeCommands()
  }
}

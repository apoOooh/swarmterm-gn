import type { AgentPaneState } from '@/lib/agent-state/rollup'
import { agentNotificationsEnabled, type NotificationPrefs } from '@/lib/notification-pref'
import { formatCommandFinished, isLongCommand, type CommandState, type FinishedCommand } from '@/lib/shell-marks'

export type NotificationKind = 'attention' | 'completion' | 'command'

export interface AgentStateTransition {
  terminalId: string
  kind: NotificationKind | 'removed'
}

/**
 * Classify what changed between two agent-state snapshots. Relies on the
 * store's dedupe (identical state never republished as a new object): a
 * reference-equal entry cannot carry a transition. `unknown → idle` is not a
 * completion (spawn settling), and the markSeen flip is not a transition.
 */
export function diffAgentStates(
  prev: Record<string, AgentPaneState>,
  next: Record<string, AgentPaneState>
): AgentStateTransition[] {
  const out: AgentStateTransition[] = []
  for (const [terminalId, cur] of Object.entries(next)) {
    const old = prev[terminalId]
    if (old === cur) continue
    if (cur.state === 'blocked' && old?.state !== 'blocked') {
      out.push({ terminalId, kind: 'attention' })
    } else if (
      cur.state === 'idle' &&
      !cur.seen &&
      (old?.state === 'working' || old?.state === 'blocked')
    ) {
      out.push({ terminalId, kind: 'completion' })
    }
  }
  for (const terminalId of Object.keys(prev)) {
    if (!(terminalId in next)) out.push({ terminalId, kind: 'removed' })
  }
  return out
}

/**
 * SWA-58: completions the user watched happen (the store marks them seen at
 * once, so diffAgentStates skips them). Only the voice reply listens here.
 */
export function diffWatchedCompletions(
  prev: Record<string, AgentPaneState>,
  next: Record<string, AgentPaneState>
): string[] {
  return Object.entries(next)
    .filter(([id, cur]) => {
      const old = prev[id]
      return old !== cur && cur.state === 'idle' && cur.seen && (old?.state === 'working' || old?.state === 'blocked')
    })
    .map(([id]) => id)
}

export type CommandTransition =
  | { terminalId: string; kind: 'command'; last: FinishedCommand }
  | { terminalId: string; kind: 'removed' }

/**
 * The plain-pane counterpart of diffAgentStates, over shell-mark snapshots.
 * Keyed on the IDENTITY of `last`, never on `phase`: bash/zsh print D and A
 * in the same precmd, so by the time a snapshot is observed the pane is
 * usually back at `prompt` — `last` is the one field that changes exactly
 * once per finished command (shell-marks carries it by reference through
 * A/B/C). Short commands are filtered here so nothing is ever armed for
 * them; fire time only has to match `finishedAt`.
 */
export function diffCommands(
  prev: Record<string, CommandState>,
  next: Record<string, CommandState>
): CommandTransition[] {
  const out: CommandTransition[] = []
  for (const [terminalId, cur] of Object.entries(next)) {
    const last = cur.last
    if (last === undefined || last === prev[terminalId]?.last) continue
    if (isLongCommand(last)) out.push({ terminalId, kind: 'command', last })
  }
  for (const terminalId of Object.keys(prev)) {
    if (!(terminalId in next)) out.push({ terminalId, kind: 'removed' })
  }
  return out
}

export interface PendingNotification {
  terminalId: string
  kind: NotificationKind
  agentId: string
  /** `command` only — the finishedAt of the record that armed it; the fire-time identity key. */
  finishedAt?: number
}

export interface FireContext {
  current: AgentPaneState | undefined
  /** Shell-mark entry of the pane — plain panes only, agent panes have none. */
  command?: CommandState
  paneWatched: boolean
  windowFocused: boolean
  prefs: NotificationPrefs
}

export interface FireVerdict {
  sound: boolean
  system: boolean
}

const DROP: FireVerdict = { sound: false, system: false }

/**
 * Fire-time re-validation, ~1 s after the transition: a blocked flash that
 * resolved itself, a pane the user has since looked at, or a dead terminal
 * must not notify. The banner additionally requires the window to be
 * unfocused AT THIS INSTANT — inside the app the chime alone is the signal.
 */
export function resolveFire(pending: PendingNotification, ctx: FireContext): FireVerdict {
  if (!isStillCurrent(pending, ctx)) return DROP
  if (ctx.paneWatched) return DROP
  if (!agentNotificationsEnabled(ctx.prefs, pending.agentId)) return DROP
  return { sound: ctx.prefs.sound, system: ctx.prefs.system && !ctx.windowFocused }
}

/**
 * The prefs-free half of resolveFire: does the fact that armed `pending`
 * still hold? The notification center records on this alone (plus the
 * watched check) — muting chimes must not empty the history.
 */
export function isStillCurrent(pending: PendingNotification, ctx: Pick<FireContext, 'current' | 'command'>): boolean {
  if (pending.kind === 'command') {
    // A plain pane has no agent-state entry, so `current` says nothing here.
    // The record that armed us must still be the pane's `last`: a newer
    // (even short) command or a respawn clear means the user has moved on.
    const last = ctx.command?.last
    return last !== undefined && last.finishedAt === pending.finishedAt
  }
  const { current } = ctx
  if (current === undefined) return false
  if (pending.kind === 'attention') return current.state === 'blocked'
  return current.state === 'idle' && !current.seen
}

/**
 * SWA-58: like isStillCurrent but ignoring `seen` — the fact for a pane the
 * user is looking at (it is seen at once). Only the voice reply uses it.
 */
export function isStillHeld(pending: PendingNotification, ctx: Pick<FireContext, 'current'>): boolean {
  const { current } = ctx
  if (pending.kind === 'command' || current === undefined) return false
  return pending.kind === 'attention' ? current.state === 'blocked' : current.state === 'idle'
}

export function notificationCopy(
  kind: NotificationKind,
  agentName: string,
  paneTitle: string,
  command?: FinishedCommand
): { title: string; body: string } {
  const title =
    kind === 'command'
      ? command === undefined
        ? 'Command finished'
        : formatCommandFinished(command)
      : kind === 'attention'
        ? `${agentName} needs your input`
        : `${agentName} finished`
  return { title, body: paneTitle }
}

export interface FiredNotification {
  kind: NotificationKind
  agentName: string
  paneTitle: string
  command?: FinishedCommand
}

export interface CoalescedNotification {
  kind: NotificationKind
  title: string
  body: string
}

/**
 * Fold every notification that survived fire-time re-validation in one batch
 * into ONE chime kind + ONE banner. A single entry is byte-identical to
 * `notificationCopy` so today's banners never change. With several, attention
 * outranks completion for the tone (a pane waiting on the user matters more
 * than one that finished) and is listed first in the copy; each kind becomes
 * one title segment, pluralised by agent name when every pane in the segment
 * belongs to the same CLI ("2 Claude Code panes finished") and generically
 * otherwise ("3 agents finished"). Hand-typed commands rank below both agent
 * kinds and their segment reads "N commands finished". Empty pane titles
 * carry no information in a group, so they are dropped from the body — only
 * the single-entry path keeps an empty body, for parity with
 * `notificationCopy`.
 */
export function coalesceNotifications(fired: readonly FiredNotification[]): CoalescedNotification | null {
  const only = fired.length === 1 ? fired[0] : undefined
  if (only !== undefined) {
    return { kind: only.kind, ...notificationCopy(only.kind, only.agentName, only.paneTitle, only.command) }
  }
  if (fired.length === 0) return null
  const attention = fired.filter((f) => f.kind === 'attention')
  const completion = fired.filter((f) => f.kind === 'completion')
  const command = fired.filter((f) => f.kind === 'command')
  // Rank for the tone and the copy: a pane waiting on the user, then an agent
  // that finished, then a hand-typed command — the least urgent fact last.
  const ordered = [attention, completion, command]
  const segments = ordered.filter((g) => g.length > 0).map(segmentTitle)
  return {
    kind: attention.length > 0 ? 'attention' : completion.length > 0 ? 'completion' : 'command',
    title: segments.join(' · '),
    body: ordered
      .flat()
      .map((f) => f.paneTitle)
      .filter((t) => t !== '')
      .join(' · ')
  }
}

// Only ever called with a non-empty, single-kind group — the caller's
// `filter((g) => g.length > 0)` guarantees `group[0]` exists.
function segmentTitle(group: readonly FiredNotification[]): string {
  const first = group[0]
  if (group.length === 1) return notificationCopy(first.kind, first.agentName, '', first.command).title
  // Commands have no CLI to pluralise by — every one belongs to "Terminal".
  if (first.kind === 'command') return `${group.length} commands finished`
  const sameAgent = group.every((f) => f.agentName === first.agentName)
  const subject = sameAgent ? `${group.length} ${first.agentName} panes` : `${group.length} agents`
  return first.kind === 'attention' ? `${subject} need your input` : `${subject} finished`
}

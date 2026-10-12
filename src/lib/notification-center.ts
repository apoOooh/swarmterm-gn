/**
 * Notification center: the in-app history behind the title-bar bell. Pure
 * list transforms only — the store holds the array, the watchers feed it.
 * Entries live for the app session (survive workspace switches, not a quit):
 * they point at live terminal ids, which mean nothing after a restart.
 */
import type { HoldReason } from '@/lib/war-room-nudge'

/** `handoff` acknowledges a SWA-22 brief delivery (sent or failed) on the new pane.
 *  `dictation` reports a voice draft that was refused (SWA-12). */
export type CenterKind =
  | 'attention'
  | 'completion'
  | 'command'
  | 'exit'
  | 'hold'
  | 'handoff'
  | 'prompt'
  | 'routine'
  | 'dictation'

export interface NewCenterEntry {
  kind: CenterKind
  terminalId: string
  title: string
  /** Pane title at record time — the pane may be renamed or gone later. */
  detail: string
  at: number
}

export interface CenterEntry extends NewCenterEntry {
  id: string
  read: boolean
}

/** Short reason copy for a held War Room delivery (HoldReason in war-room-nudge). */
export const HOLD_REASON_COPY: Record<HoldReason, string> = {
  'agent-blocked': 'agent needs input',
  'agent-working': 'agent working',
  typing: 'you are typing'
}

/** Bounded so a chatty War Room cannot grow renderer memory forever. */
export const MAX_ENTRIES = 100

let seq = 0

/**
 * Newest first. An UNREAD entry of the same pane and kind is replaced and
 * moved to the top: a pane that blocks three times before the user looks
 * is one fact ("still waiting"), not three. Read entries stay as history.
 */
export function addEntry(list: readonly CenterEntry[], entry: NewCenterEntry): CenterEntry[] {
  const rest = list.filter((x) => x.read || x.terminalId !== entry.terminalId || x.kind !== entry.kind)
  seq += 1
  return [{ ...entry, id: `n${entry.at}-${seq}`, read: false }, ...rest].slice(0, MAX_ENTRIES)
}

export function unreadCount(list: readonly CenterEntry[]): number {
  return list.reduce((n, x) => (x.read ? n : n + 1), 0)
}

// Every mark* returns the SAME array when nothing changed, so a zustand
// setter built on them does not re-render subscribers for a no-op.
function markWhere(list: CenterEntry[], hit: (x: CenterEntry) => boolean): CenterEntry[] {
  if (!list.some((x) => !x.read && hit(x))) return list
  return list.map((x) => (!x.read && hit(x) ? { ...x, read: true } : x))
}

export function markRead(list: CenterEntry[], id: string): CenterEntry[] {
  return markWhere(list, (x) => x.id === id)
}

/** The user looked at the pane: its entries (optionally only some kinds) are read. */
export function markTerminalRead(
  list: CenterEntry[],
  terminalId: string,
  kinds?: readonly CenterKind[]
): CenterEntry[] {
  return markWhere(list, (x) => x.terminalId === terminalId && (kinds === undefined || kinds.includes(x.kind)))
}

export function markAllRead(list: CenterEntry[]): CenterEntry[] {
  return markWhere(list, () => true)
}

export function clearAll(_list: readonly CenterEntry[]): CenterEntry[] {
  return []
}

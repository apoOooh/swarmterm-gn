import type { NotificationKind } from '@/lib/notification-flow'
import type { NewCenterEntry } from '@/lib/notification-center'
import { resolvePaneTitle } from '@/lib/pane-title'

/**
 * Voice backchannel (SWA-41): the agent facts Swarmterm may announce
 * ("<pane>: done" / "<pane> needs input"). Only the status leaves the
 * renderer — no screen text. Rust matches a Claude "done" against its turn
 * ledger (SWA-58) and may speak the agent's own reply instead; pipe
 * subscribers only ever get done/needs_input of unwatched panes.
 */
export interface Announcement {
  terminalId: string
  kind: NotificationKind
  agentId: string
  /** The user is looking at this pane (SWA-58: reply only, never pushed). */
  watched: boolean
}

export interface TurnEvent {
  terminalId: string
  kind: 'done' | 'needs_input'
  paneName: string
  agent: string
  watched: boolean
}

export function turnEventFor(a: Announcement, agentTitle: string): TurnEvent | null {
  if (a.kind === 'command') return null
  return {
    terminalId: a.terminalId,
    kind: a.kind === 'attention' ? 'needs_input' : 'done',
    paneName: resolvePaneTitle(a.agentId, agentTitle),
    agent: a.agentId,
    watched: a.watched
  }
}

/** `voice:turn-kind` (SWA-58): a Claude turn that failed or was stopped with Esc. */
export interface TurnKindEvent {
  terminalId: string
  kind: 'error' | 'interrupted'
}

/** The bell entry for it — ids and the pane title, never output text. */
export function turnKindEntry(e: TurnKindEvent, paneTitle: string, at: number): NewCenterEntry {
  return {
    kind: e.kind,
    terminalId: e.terminalId,
    title: e.kind === 'error' ? 'Agent turn failed' : 'Agent turn interrupted',
    detail: paneTitle,
    at
  }
}

import type { NotificationKind } from '@/lib/notification-flow'
import { resolvePaneTitle } from '@/lib/pane-title'

/**
 * Voice backchannel (SWA-41, stage 1): the agent facts a dictation app may
 * announce ("<pane>: done" / "<pane> needs input"). Only the status leaves
 * the app — no excerpt, no screen text; Rust adds `seq` and fans it out to
 * pipe subscribers, gated on Settings → Voice.
 */
export interface Announcement {
  terminalId: string
  kind: NotificationKind
  agentId: string
}

export interface TurnEvent {
  terminalId: string
  kind: 'done' | 'needs_input'
  paneName: string
  agent: string
}

export function turnEventFor(a: Announcement, agentTitle: string): TurnEvent | null {
  if (a.kind === 'command') return null
  return {
    terminalId: a.terminalId,
    kind: a.kind === 'attention' ? 'needs_input' : 'done',
    paneName: resolvePaneTitle(a.agentId, agentTitle),
    agent: a.agentId
  }
}

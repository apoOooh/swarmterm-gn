import type { NewCenterEntry } from '@/lib/notification-center'

/**
 * Backend failures go to the notification center (the bell). They belong to
 * no pane, so each service gets a pseudo terminal id: the bell shows the
 * entry's detail as its subtitle and clicking it only marks it read (there is
 * no pane to reveal, see lib/notification-entry-view.ts), and a repeat failure replaces the unread entry
 * instead of stacking (addEntry dedupes by id + kind).
 */
export const MCP_ALERT_ID = 'backend:mcp'
export const VOICE_ALERT_ID = 'backend:voice'

export function mcpExitedEntry(reason: string, at: number): NewCenterEntry {
  return { kind: 'backend', terminalId: MCP_ALERT_ID, title: 'MCP server stopped', detail: reason, at }
}

export function voicePipeErrorEntry(payload: { message?: string } | null | undefined, at: number): NewCenterEntry {
  return { kind: 'backend', terminalId: VOICE_ALERT_ID, title: 'Voice input failed', detail: payload?.message ?? '', at }
}

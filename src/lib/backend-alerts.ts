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

export const INPUT_ALERT_ID = 'backend:input'

/**
 * A pane's pty input queue was full (the program stopped reading) and a write
 * was dropped. Not filed under the pane's own id: an `attention` entry there
 * would replace the agent's real "needs attention" entry.
 */
export function inputDroppedEntry(paneLabel: string, at: number): NewCenterEntry {
  return {
    kind: 'backend',
    terminalId: INPUT_ALERT_ID,
    title: 'Input dropped',
    detail: `${paneLabel} is not reading input; the last paste or keystrokes were not sent`,
    at
  }
}

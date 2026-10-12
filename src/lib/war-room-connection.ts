/** How long a dragged-in agent pane may stay unconnected before the chip
 *  turns from "waiting" into an error with a reason. Agent CLIs open their
 *  MCP connection at startup, so a healthy pane is connected on join or
 *  within a few seconds of launching. */
export const CONNECT_GRACE_MS = 15_000

export type ConnectionKind = 'connected' | 'waiting' | 'error'

export interface ConnectionStatus {
  kind: ConnectionKind
  label: string
  reason: string
}

export interface ConnectionInput {
  connected: boolean
  agentId: string | null
  /** Swarmterm writes this agent's MCP config itself (claude/codex/qwen). */
  autoEnrolled: boolean
  joinedAt: number
  now: number
}

const SETTINGS_HINT =
  'Check Settings → MCP: the Swarmterm switch must be on for this agent and account. ' +
  'Then restart the pane so the agent reloads its MCP configuration.'

export const MANUAL_HINT =
  'To connect this pane manually, point its MCP config at $SWARMTERM_MCP_URL ' +
  'with header "Authorization: Bearer $SWARMTERM_SESSION" ' +
  "(both are set in this terminal's environment)."

/** Pure status for the War Room member chip and the pane header. */
export function connectionStatus(i: ConnectionInput): ConnectionStatus {
  if (i.connected) {
    return { kind: 'connected', label: 'connected', reason: 'The agent in this pane is connected to the War Room.' }
  }
  if (i.agentId === null) {
    return {
      kind: 'error',
      label: 'no agent',
      reason: `A plain shell cannot take part in the War Room. ${MANUAL_HINT}`
    }
  }
  if (!i.autoEnrolled) {
    return { kind: 'error', label: 'manual setup', reason: `Swarmterm does not configure this agent automatically. ${MANUAL_HINT}` }
  }
  if (i.now - i.joinedAt < CONNECT_GRACE_MS) {
    return { kind: 'waiting', label: 'waiting', reason: 'Waiting for the agent in this pane to connect to Swarmterm.' }
  }
  return {
    kind: 'error',
    label: 'not connected',
    reason: `The agent in this pane has not reached Swarmterm's MCP server. ${SETTINGS_HINT}`
  }
}

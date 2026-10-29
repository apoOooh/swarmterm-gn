/**
 * Settings → Terminal → Agent safety: what one agent may make another pane do. Enforced in
 * Rust (`agent_policy::AgentPolicy`, checked on every MCP call); the renderer
 * only stores and pushes it. Field names are in lockstep with that struct
 * (camelCase serde).
 */
export interface AgentPolicy {
  /** War Room `mode: "execute"` from agents over MCP. Moderator sends from
   *  the UI are not affected. */
  allowWarRoomExecute: boolean
  /** `worktree.spawn` workers of the same agent inherit the requester's
   *  Bypass/YOLO mode (user decision 2026-10-29, default off). Forced off by
   *  the admin policy DisableBypassModes. */
  workersInheritBypass: boolean
}

export const DEFAULT_AGENT_POLICY: AgentPolicy = { allowWarRoomExecute: false, workersInheritBypass: false }

export const AGENT_POLICY_KEY = 'swarmterm.agentPolicy'

/** Field-wise validation: anything but a literal `true` keeps the secure default. */
export function parseAgentPolicy(raw: unknown): AgentPolicy {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { allowWarRoomExecute: o.allowWarRoomExecute === true, workersInheritBypass: o.workersInheritBypass === true }
}

export function readAgentPolicy(storage: Pick<Storage, 'getItem'>): AgentPolicy {
  try {
    const stored = storage.getItem(AGENT_POLICY_KEY)
    if (stored !== null) return parseAgentPolicy(JSON.parse(stored))
  } catch {
    // Unreadable or corrupt storage: the default below.
  }
  return { ...DEFAULT_AGENT_POLICY }
}

export function storeAgentPolicy(storage: Pick<Storage, 'setItem'>, policy: AgentPolicy): void {
  try {
    storage.setItem(AGENT_POLICY_KEY, JSON.stringify(policy))
  } catch {
    // Full or blocked storage: the setting still applies for this session.
  }
}

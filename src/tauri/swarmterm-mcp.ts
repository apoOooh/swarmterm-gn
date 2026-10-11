import { invoke } from '@tauri-apps/api/core'

/** Swarmterm's own MCP entry for one agent profile (Settings → MCP switch). */
export interface SwarmtermMcpProfile {
  agentId: string
  accountId: string | null
  accountName: string | null
  enabled: boolean
  /** `foreign` = a user-defined `swarmterm` server Swarmterm never touches. */
  entry: 'absent' | 'ours' | 'foreign' | 'perPane'
  configPath: string
  url: string | null
}

export const swarmtermMcpProfiles = (): Promise<SwarmtermMcpProfile[]> => invoke('swarmterm_mcp_profiles')

export const setSwarmtermMcp = (agentId: string, accountId: string | null, enabled: boolean): Promise<void> =>
  invoke('set_swarmterm_mcp', { agentId, accountId, enabled })

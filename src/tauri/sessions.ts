import { invoke } from '@tauri-apps/api/core'
import type { AgentSessionEntry } from '@/lib/agent-sessions'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { SavedLeaf } from '@/lib/saved-workspaces'
import type { SavedWorkspaceInspection } from '@/lib/saved-workspace-restore'

/** Recent resumable sessions recorded for `folder` by the agent CLIs
 *  themselves. Backend is fail-open: errors surface as an empty list. */
export const listAgentSessions = (folder: string, accountId?: string): Promise<AgentSessionEntry[]> =>
  invoke('list_agent_sessions', { folder, accountId })

export interface AgentSessionEvent { terminalId: string; agentId: string; sessionId: string; atMs: number }
export const onAgentSession = (handler: (e: AgentSessionEvent) => void): Promise<UnlistenFn> =>
  listen<AgentSessionEvent>('agent:session', event => handler(event.payload))
export const inspectSavedWorkspace = (cwd: string, panes: Pick<SavedLeaf, 'cwd' | 'agentId' | 'sessionId' | 'accountId'>[]): Promise<SavedWorkspaceInspection> =>
  invoke('inspect_saved_workspace', { cwd, panes: panes.map(({ cwd, agentId, sessionId, accountId }) => ({ cwd, agentId, sessionId, accountId })) })

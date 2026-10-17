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

export interface ThreadMessage { role: 'user' | 'assistant' | 'tool'; text: string; at?: string }
export interface AgentThread { found: boolean; truncated: boolean; messages: ThreadMessage[] }
/** Read-only conversation of one session (SWA-25), lockstep with
 *  `src-tauri/src/sessions/thread.rs::Thread`. Fail-open: `found: false`. */
export const readAgentThread = (agentId: string, sessionId: string, accountId?: string): Promise<AgentThread> =>
  invoke('read_agent_thread', { agentId, sessionId, accountId })

/** Copy one session into another subscription's store (SWA-64) so it can be
 *  resumed there; the source stays. `undefined` is the default profile. */
export const transferAgentSession = (agentId: string, sessionId: string, fromAccountId: string | undefined, toAccountId: string | undefined): Promise<void> =>
  invoke('transfer_agent_session', { agentId, sessionId, fromAccountId: fromAccountId ?? null, toAccountId: toAccountId ?? null })

/** Lockstep with `src-tauri/src/sessions/share.rs::ShareSettings`. */
export interface SessionShareSettings { claude: boolean; includeDefault: boolean }
export const getSessionShare = (): Promise<SessionShareSettings> => invoke('get_session_share')
export const setSessionShare = (settings: SessionShareSettings): Promise<SessionShareSettings> =>
  invoke('set_session_share', { settings })

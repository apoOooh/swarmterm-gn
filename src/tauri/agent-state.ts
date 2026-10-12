import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { DisplayState } from '@/lib/agent-state/types'

/**
 * Push one pane's agent display state down to Rust (`commands::report_agent_state`),
 * where the MCP War Room peer verbs read it. Rust drops reports for ids that are
 * not live terminals, so a report racing a kill is harmless.
 */
export const reportAgentState = (id: string, display: DisplayState): Promise<void> =>
  invoke('report_agent_state', { id, display })

/**
 * One Claude Code hook event, relayed by Rust's `POST /hook` route. Mirrors
 * `src-tauri/src/hook/mod.rs::AgentHookEvent` (serde camelCase / snake_case
 * signal) — keep the two in lockstep. `forget` means the pane's session
 * started or ended: drop hook authority and let screen-scrape resume alone.
 * Consumed by S5.3's detector routing.
 */
export type AgentHookSignal = 'working' | 'blocked' | 'idle' | 'forget'

export interface AgentHookEvent {
  terminalId: string
  signal: AgentHookSignal
  atMs: number
}

export const onAgentHook = (handler: (e: AgentHookEvent) => void): Promise<UnlistenFn> =>
  listen<AgentHookEvent>('agent:hook', (event) => handler(event.payload))

/**
 * One context-window usage sample for a Claude Code pane, relayed by Rust's
 * `GET /status?ctx=` route (the status line rides its own percentage on the
 * probe it already sends every render). Mirrors
 * `src-tauri/src/mcp/context_usage.rs::AgentContextEvent` (serde camelCase) —
 * keep the two in lockstep. Rust dedupes on the rounded integer, so one event
 * means the chip's number actually changed. `pct: null` means the pane has no
 * context data any more — cleared on `/clear`-style resets, session end, or a
 * status line that could not parse its stdin — and the chip must disappear
 * rather than show 0 %. Consumed by S15.2's context chip.
 */
export interface AgentContextEvent {
  terminalId: string
  pct: number | null
  atMs: number
}

/**
 * One account rate-limit sample from a Claude Code pane (`GET /status?rl5=…`),
 * lockstep with `src-tauri/src/mcp/rate_limits.rs::AgentUsageEvent`. Rust only
 * emits on change and never emits an empty sample.
 */
export interface AgentUsageEvent {
  terminalId: string
  fiveHour: { pct: number; resetsAt: number | null } | null
  sevenDay: { pct: number; resetsAt: number | null } | null
  atMs: number
}

export const onAgentUsage = (handler: (e: AgentUsageEvent) => void): Promise<UnlistenFn> =>
  listen<AgentUsageEvent>('agent:usage', (event) => handler(event.payload))

export const onAgentContext = (handler: (e: AgentContextEvent) => void): Promise<UnlistenFn> =>
  listen<AgentContextEvent>('agent:context', (event) => handler(event.payload))

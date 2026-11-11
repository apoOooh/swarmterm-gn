import type { AgentEngineState, Verdict } from '@/lib/agent-state/types'

/**
 * Precedence between Claude Code's own hooks (`swarmterm --hook`, delivered
 * as `agent:hook` events) and the screen-scrape verdict. A hook is an exact
 * edge — Claude itself told us the turn ended or a permission prompt opened —
 * while the scrape is a heuristic guess over a redraw. So a live hook is
 * authoritative and the scrape only fills the gaps the hook cannot see.
 *
 * Hooks carry a TTL because the stream of edges is incomplete: an **Esc**
 * interrupt fires no Stop, so a `working` mark would otherwise pin the dot
 * yellow forever on a pane that is actually idle. The TTL is the ONLY thing
 * that retires a mark; every arriving hook overwrites the previous one.
 * `forget` (SessionEnd) is not a mark — the detector nulls its hook instead.
 *
 * Pure and timer-free like `pending-idle.ts`: the detector passes `now`.
 */

/** Esc/interrupt fires no Stop; PostToolUse refreshes the mark mid-turn, so
 *  a real turn never gets 30 s stale while a dead one clears within it. */
export const TTL_WORKING_MS = 30_000
/** An approval turns into PostToolUse → `working` long before this; the TTL
 *  only matters when the user walks away from the prompt. */
export const TTL_BLOCKED_MS = 600_000
/** Just long enough to outlive the trailing redraw after Stop, so the scrape
 *  cannot flicker the pane back to `working` on Claude's final frame. */
export const TTL_IDLE_MS = 5_000

export type HookSignal = 'working' | 'blocked' | 'idle'

/**
 * Detectors whose agent sends its own hooks and whose manifest was tuned
 * against them (the visibleIdle/visibleBlocker flags `resolveHookState`
 * arbitrates on). Codex joined with SWA-71: its UserPromptSubmit/Stop/
 * Interrupt hooks. Rust only forwards a Codex pane's edges that name the
 * pane's own Codex session, so a nested `claude` cannot drive it.
 */
export function acceptsAgentHooks(manifestId: string | null | undefined): boolean {
  return manifestId === 'claude-code' || manifestId === 'codex'
}

export interface HookMark {
  signal: HookSignal
  /** Detector clock (`deps.now()`) at arrival — NOT the event's own `atMs`,
   *  so one clock drives both the TTL and the tick scheduler. */
  atMs: number
}

const TTL_MS: Record<HookSignal, number> = {
  working: TTL_WORKING_MS,
  blocked: TTL_BLOCKED_MS,
  idle: TTL_IDLE_MS,
}

/** True while the mark is strictly inside its TTL (`now - atMs < ttl`). */
export function isHookLive(hook: HookMark | null, now: number): boolean {
  if (!hook) return false
  return now - hook.atMs < TTL_MS[hook.signal]
}

export interface HookResolution {
  state: AgentEngineState
  /** Only ever true on the hook-idle branch: Stop IS the confirmation that
   *  the pending-idle hold exists to approximate, so the detector publishes
   *  idle on the same tick instead of waiting for three quiet rechecks. */
  bypassIdleHold: boolean
}

/**
 * First matching rule wins:
 * 1. No live hook → the scrape verdict as-is.
 * 2. Hook `blocked` yields only to a scrape that sees `working`: the user has
 *    approved and the tool is already spinning, but PostToolUse has not fired
 *    yet. Everything else (idle, visible-idle, blocked, unknown) is the
 *    permission prompt still on screen → `blocked`.
 * 3. Hook `working` yields only to a *visible* blocker — an AskUserQuestion /
 *    elicitation box the hook never saw. It must NOT yield to `visibleIdle`:
 *    Claude keeps the `❯` prompt box on screen mid-turn, so `live_prompt_box`
 *    fires on exactly the false-idle frames the hook exists to overrule.
 * 4. Hook `idle` (Stop) yields to a visible blocker the same way; otherwise
 *    it is idle now, with the hold bypassed.
 */
export function resolveHookState(args: {
  hook: HookMark | null
  scrape: Verdict
  now: number
}): HookResolution {
  const { hook, scrape, now } = args
  if (!hook || !isHookLive(hook, now)) {
    return { state: scrape.state, bypassIdleHold: false }
  }
  const visibleBlocker = scrape.state === 'blocked' && scrape.visibleBlocker
  switch (hook.signal) {
    case 'blocked':
      return {
        state: scrape.state === 'working' ? 'working' : 'blocked',
        bypassIdleHold: false,
      }
    case 'working':
      return { state: visibleBlocker ? 'blocked' : 'working', bypassIdleHold: false }
    case 'idle':
      return visibleBlocker
        ? { state: 'blocked', bypassIdleHold: false }
        : { state: 'idle', bypassIdleHold: true }
  }
}

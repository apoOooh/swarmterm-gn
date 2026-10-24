/**
 * War Room delivery texts + flush ordering. Pure — the store queues
 * PendingDeliveries per terminal and the delivery wiring decides WHEN
 * (sustained idle); this module decides WHAT gets typed.
 *
 * Probe bodies deliberately never appear here: only a short nudge is typed
 * into the agent's terminal and the content stays in the MCP inbox, so
 * cross-agent chatter can't bloat an agent's context window.
 */

import type { AgentEngineState } from '@/lib/agent-state/types'

/** Idle must hold this long before typing into a pane. Deliberately above the
 *  activity tracker's 1100ms so a brief pause mid-turn never reads as "done". */
export const NUDGE_IDLE_MS = 3000

export interface PendingDelivery {
  fromName: string
  mode: 'probe' | 'execute'
  /** Full prompt for execute deliveries; probes carry no body. */
  content?: string
}

export function buildNudgeText(fromNames: string[]): string {
  const unique = [...new Set(fromNames)]
  const who = unique.join(', ')
  if (fromNames.length === 1) {
    return `[War Room] New message from ${who}. Call the war_room.read_inbox tool to read it, then reply with war_room.send.`
  }
  return `[War Room] ${fromNames.length} new messages (from ${who}). Call the war_room.read_inbox tool to read them, then reply with war_room.send.`
}

export function buildIntroText(roomName: string, peerNames: string[]): string {
  const with_ = peerNames.length > 0 ? ` with ${peerNames.join(', ')}` : ''
  return (
    `[War Room] You joined Swarmterm's War Room "${roomName}"${with_}. ` +
    `First call war_room.list_peers now — that confirms your connection (until then ` +
    `peers see you as pending and cannot message you). ` +
    `Tools: war_room.list_peers (who is here), war_room.send (mode "probe" to message a peer, ` +
    `mode "execute" to hand a peer a prompt their terminal will run), war_room.read_inbox ` +
    `(read messages sent to you — you will be nudged). ` +
    // The human is a peer like any other, so agents must be told the id and
    // that this one peer has no terminal to be nudged in.
    `The peer "Moderator" (terminalId "__moderator__") is the human user driving Swarmterm: ` +
    `war_room.send to them when you need a decision. They read everything in the panel and ` +
    `have no terminal, so never send them mode "execute". ` +
    `Coordinate through these tools and keep message bodies out of the terminal.`
  )
}

/** Paste payloads for one idle window: executes verbatim in arrival order,
 *  then a single merged nudge covering every queued probe. */
export function flushQueue(queue: PendingDelivery[]): string[] {
  const out: string[] = []
  for (const d of queue) {
    if (d.mode === 'execute' && d.content !== undefined) out.push(d.content)
  }
  const probes = queue.filter((d) => d.mode === 'probe')
  if (probes.length > 0) out.push(buildNudgeText(probes.map((d) => d.fromName)))
  return out
}

/**
 * How long after the last keystroke a focused pane still counts as "being
 * typed in". Deliberately well above NUDGE_IDLE_MS: the two guards answer
 * different questions (has the pty stopped talking? has the user stopped
 * typing?) and a pane is routinely output-idle while the user is mid-sentence.
 */
export const TYPING_QUIET_MS = 6000

export interface TypingSnapshot {
  /** Is this the pane the keyboard currently goes to? */
  focused: boolean
  /** ms epoch of the last user input, or undefined if never typed in. */
  lastKeyAt: number | undefined
  /** A line has been typed here and not yet submitted or abandoned. */
  dirty: boolean
}

/** Why a queued delivery is being withheld from a pane. Order of precedence
 *  is blocked → working → draft → typing → pane-busy: the agent reasons come
 *  first because a flush is body writes PLUS an Enter, and on a permission
 *  prompt that Enter is an approval — the user clearing their own typing must
 *  not release it. `pane-busy` is the scheduler's output gate (the pane kept
 *  printing above repaint-noise level, see `busyPaneReady`). */
export type HoldReason = 'agent-blocked' | 'agent-working' | 'draft' | 'typing' | 'pane-busy'

export interface DeliverySnapshot extends TypingSnapshot {
  /** Raw engine state for this pane; undefined when the engine has no entry
   *  (plain shell, no manifest, or cleared on kill). Never `displayState` —
   *  the seen-bit behind `done` is a UI concern, not a safety signal. */
  agentState?: AgentEngineState
  /** The agent's input box shows unsent text (see prompt-draft.ts). Typing a
   *  nudge would append to it and the Enter would send the user's draft. */
  draft?: boolean
}

/**
 * Why typing into this pane right now would be wrong — or null if it's safe.
 * There is no maximum hold on purpose — force-delivering after N seconds would
 * reintroduce exactly the corruption this guards against, just more rarely.
 * The escape for the typing reason is the user-facing "Deliver now"
 * affordance, which clears the typing signal instead of bypassing this rule;
 * the agent reasons have no escape and release only when the engine says idle.
 */
export function deliveryHoldReason(s: DeliverySnapshot, now: number): HoldReason | null {
  // A permission/question prompt is output-idle, so the clock gate alone
  // would type into it; and a silent long tool call is output-idle too.
  // `unknown` deliberately falls through to the clock — the engine has no
  // opinion, and the pre-Đ2 behaviour is the right fallback.
  if (s.agentState === 'blocked') return 'agent-blocked'
  if (s.agentState === 'working') return 'agent-working'
  // Screen evidence, independent of the typing store: a draft restored by a
  // host reattach, or typed before Swarmterm restarted, has no dirty flag, and
  // "Deliver now" clearing the typing signal must not release it either.
  if (s.draft === true) return 'draft'
  // Unfocused-but-dirty still holds: the line survives losing focus.
  if (s.dirty) return 'typing'
  if (!s.focused) return null
  // Safety net for input the dirty flag can miss — a TUI consuming keystrokes
  // through a path `onData` does not represent.
  return s.lastKeyAt !== undefined && now - s.lastKeyAt < TYPING_QUIET_MS ? 'typing' : null
}

/** Boolean view of `deliveryHoldReason` for callers that only need yes/no. */
export function shouldDeferDelivery(s: DeliverySnapshot, now: number): boolean {
  return deliveryHoldReason(s, now) !== null
}

/**
 * Relaxed gate for a pane that is still printing. Real agent TUIs are never
 * fully quiet at their prompt: a status line re-rendered every few seconds, a
 * blinking-cursor repaint or a title update restarts the strict
 * NUDGE_IDLE_MS countdown forever, so the strict gate alone held nudges
 * indefinitely. Below this smoothed rate, output counts as repaint noise. A
 * 1-2 KB status line every 5 s decays under it within ~1.5 s (tau 1 s, see
 * renderer-policy); a streaming answer or a 100 ms spinner stays above it.
 */
export const NOISE_BYTES_PER_SEC = 512
/** The detector must have said `idle` this long before the relaxed gate
 *  trusts it — its own working→idle debounce already settled the verdict,
 *  this just keeps a fresh idle from racing the last bytes of a turn. */
export const IDLE_DWELL_MS = 1500
/** Safety valve: idle-by-detector this long (and waiting this long) delivers
 *  even when the output rate never drops — e.g. a TUI that animates
 *  something constantly at its prompt. Never applies to blocked/working/
 *  typing: those are decided by `deliveryHoldReason` before this runs. */
export const MAX_IDLE_HOLD_MS = 20000

export interface BusyPaneSnapshot {
  agentState?: AgentEngineState
  /** ms epoch the engine entered `agentState` (agent-state-store sinceMs). */
  agentSinceMs?: number
  /** Smoothed pane output rate, bytes/s. */
  outputBytesPerSec: number
  /** ms epoch the queue started waiting for this pane. */
  waitingSinceMs: number
  /** The user clicked "Deliver now" on a pane-busy hold. */
  forced: boolean
}

/**
 * May a queue be flushed into a pane that has NOT been output-quiet for
 * NUDGE_IDLE_MS? Call only after `deliveryHoldReason` returned null — a
 * blocked prompt, a working agent and user typing are never released here.
 * `unknown`/no detector never qualifies (except forced): without an engine
 * verdict, output is the only signal there is.
 */
export function busyPaneReady(s: BusyPaneSnapshot, now: number): boolean {
  if (s.forced) return true
  if (s.agentState !== 'idle' || s.agentSinceMs === undefined) return false
  const idleFor = now - s.agentSinceMs
  if (idleFor >= IDLE_DWELL_MS && s.outputBytesPerSec < NOISE_BYTES_PER_SEC) return true
  return Math.min(idleFor, now - s.waitingSinceMs) >= MAX_IDLE_HOLD_MS
}

/** UI copy per reason. `releasable` = "Deliver now" may be offered: for
 *  `typing` it clears the typing signal, for `pane-busy` it waives the output
 *  gate once (`requestDeliverNow`). Neither touches the agent/draft rules —
 *  a real bypass would press Enter on the very prompt the agent is waiting
 *  on, or send the user's unsent draft. */
export function holdReasonCopy(reason: HoldReason): { title: string; releasable: boolean } {
  switch (reason) {
    case 'pane-busy':
      return {
        title:
          'Held — the pane is still printing output. Delivers when it settles, or at most ' +
          `${MAX_IDLE_HOLD_MS / 1000} s after the agent is idle. Click to deliver now.`,
        releasable: true
      }
    case 'draft':
      // Deliberately no release and no timeout: any release would type into
      // the draft and its Enter would send it. A false positive (prompt-like
      // non-dim text in the box) costs a held nudge the tooltip explains —
      // the agent still finds the message via read_inbox.
      return {
        title:
          "Held — the agent's input box has unsent text. Delivers once you send or clear it " +
          '(a nudge would be appended to your draft and submit it).',
        releasable: false
      }
    case 'typing':
      return { title: "Held because you're typing here. Click to deliver now.", releasable: true }
    case 'agent-blocked':
      return {
        title: 'Held — the agent is waiting on a permission or question prompt. Delivers once it is idle.',
        releasable: false
      }
    case 'agent-working':
      return { title: 'Held — the agent is still working. Delivers once it is idle.', releasable: false }
  }
}

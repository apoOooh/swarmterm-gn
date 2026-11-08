/**
 * Watches the war-room queues and the per-terminal activity flag, and types
 * queued deliveries into a pane only after NUDGE_IDLE_MS of sustained quiet.
 * Wiring lives outside React (like terminal-registry) because deliveries must
 * fire while the War Room panel — or the whole right panel — is unmounted.
 */
import {
  deliverPromptToTerminal,
  paneHasPromptDraft,
  paneOutputRate,
  submitTerminalPrompt
} from '@/lib/terminal-registry'
import { NUDGE_IDLE_MS, busyPaneReady, deliveryHoldReason, type HoldReason } from '@/lib/war-room-nudge'
import { useAgentStateStore } from '@/store/agent-state-store'
import { selectFocusedTerminalId, useAppStore } from '@/store/app-store'
import { useTerminalActivityStore } from '@/store/terminal-activity-store'
import { useTerminalTypingStore } from '@/store/terminal-typing-store'
import { useWarRoomStore } from '@/store/war-room-store'

/**
 * Gap between a flushed payload's body write and its Enter. Must land as its
 * own later input-loop tick, not glued onto the paste's close marker — the
 * target TUI guards against an Enter arriving in the same stdin flush as a
 * paste (see `deliverPromptToTerminal`'s doc comment), so anything sent in
 * the same flush is eaten. 300ms is one tick past that flush, comfortably
 * clear of any paste-burst coalescing window the TUI might apply.
 */
export const SUBMIT_DELAY_MS = 300

/**
 * How often a held queue re-asks "is it safe to type here yet?". The recency
 * arm of `deliveryHoldReason` expires on a clock, not on a store write, so a
 * timer is the only thing that can release it. The typing and agent-state
 * subscriptions below just make an Enter (or an engine flip to idle) release
 * it sooner than this interval — and the timer is belt-and-braces for the
 * agent reasons too, should a store write ever be missed.
 */
export const HOLD_RECHECK_MS = 750

/** Set while a scheduler runs; see `requestDeliverNow`. */
let deliverNowHandler: ((terminalId: string) => void) | null = null

/**
 * The "Deliver now" action for a `pane-busy` hold: waives the output gate
 * once for this queue. Every other rule (blocked, working, draft, typing)
 * is still checked — this never presses Enter on a prompt or a draft.
 */
export function requestDeliverNow(terminalId: string): void {
  deliverNowHandler?.(terminalId)
}

/** What a releasable hold's "Deliver now" click does, per reason (see
 *  `holdReasonCopy`): typing → clear the typing signal; pane-busy → waive
 *  the output gate once. Other reasons are not releasable and do nothing. */
export function releaseHeld(terminalId: string, reason: HoldReason): void {
  if (reason === 'typing') useTerminalTypingStore.getState().clearTyping(terminalId)
  else if (reason === 'pane-busy') requestDeliverNow(terminalId)
}

export function startWarRoomDelivery(): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** When each queue started waiting (safety valve + badge delay). */
  const waitingSince = new Map<string, number>()
  /** Queues whose output gate the user waived via "Deliver now". */
  const forced = new Set<string>()
  // Body/submit writes staggered off a fired idle timer. Kept separate from
  // `timers` (which only ever holds the per-terminal idle countdown, one
  // entry per terminal) because a single flush can schedule several of
  // these at once and `stop()` must be able to cancel them even after the
  // idle timer that spawned them has already fired and been forgotten.
  const pending = new Set<ReturnType<typeof setTimeout>>()

  const cancel = (terminalId: string): void => {
    const t = timers.get(terminalId)
    if (t !== undefined) {
      clearTimeout(t)
      timers.delete(terminalId)
    }
  }

  /** Why typing into this pane right now would be wrong — or null if it's safe.
   *  Raw engine state, never displayState: the seen-bit is a UI concern. */
  function holdReason(terminalId: string): HoldReason | null {
    const typing = useTerminalTypingStore.getState()
    const agentState = useAgentStateStore.getState().byId[terminalId]?.state
    return deliveryHoldReason(
      {
        focused: selectFocusedTerminalId(useAppStore.getState()) === terminalId,
        lastKeyAt: typing.lastKeyAt[terminalId],
        dirty: typing.dirty[terminalId] ?? false,
        agentState,
        // Screen read, only here (flush time / held rechecks) — never per
        // output batch — and skipped when an agent reason already holds.
        draft: agentState !== 'blocked' && agentState !== 'working' && paneHasPromptDraft(terminalId)
      },
      Date.now()
    )
  }

  /** Every hold-reason change is logged once, so "why didn't my peer get
   *  it?" can be answered from the devtools console after the fact. */
  function setHeldLogged(terminalId: string, reason: HoldReason | null): void {
    const prev = useWarRoomStore.getState().held[terminalId] ?? null
    if (prev === reason) return
    console.info(`[war-room] delivery to ${terminalId}: ${reason === null ? 'released' : `held (${reason})`}`)
    useWarRoomStore.getState().setHeld(terminalId, reason)
  }

  const onDeliverNow = (terminalId: string): void => {
    if (useWarRoomStore.getState().held[terminalId] !== 'pane-busy') return
    forced.add(terminalId)
    cancel(terminalId)
    fire(terminalId, true)
  }
  deliverNowHandler = onDeliverNow

  /** Arm the one timer a queued terminal has. Quiet pane: the strict
   *  countdown (`delay`, NUDGE_IDLE_MS by default) — the fast path. Pane
   *  still printing: a HOLD_RECHECK_MS poll of the relaxed gate
   *  (`busyPaneReady`), because real agent panes repaint (status line,
   *  cursor, title) more often than the strict countdown can ever finish.
   *  Timers only exist while a queue is pending — nothing runs for idle
   *  panes with nothing to deliver. `delay` applies to the quiet path only:
   *  a wake-up's `schedule(id, 0)` on a busy pane still waits one poll. */
  function schedule(terminalId: string, delay: number = NUDGE_IDLE_MS): void {
    if (timers.has(terminalId)) return
    if (!waitingSince.has(terminalId)) waitingSince.set(terminalId, Date.now())
    const busy = useTerminalActivityStore.getState().active[terminalId] ?? false
    timers.set(
      terminalId,
      setTimeout(() => fire(terminalId, busy), busy ? HOLD_RECHECK_MS : delay)
    )
  }

  function forget(terminalId: string): void {
    waitingSince.delete(terminalId)
    forced.delete(terminalId)
  }

  function fire(terminalId: string, armedBusy: boolean): void {
    timers.delete(terminalId)
    const busy = useTerminalActivityStore.getState().active[terminalId] ?? false
    // A strict countdown that output overtook: the activity edge normally
    // cancels it first; re-arm as a busy poll instead of flushing.
    if (busy && !armedBusy) {
      schedule(terminalId)
      return
    }
    const room = useWarRoomStore.getState()
    if ((room.queues[terminalId]?.length ?? 0) === 0) {
      forget(terminalId)
      return
    }
    // Membership re-check closes a cross-thread race: the Rust MCP worker
    // (deliver) and the command/reader thread (leave) emit independently,
    // so a `warroom:deliver` for a terminal that just left can be applied
    // to the store AFTER the leave — re-creating a queue for an evicted
    // terminal. Without this, 3s later the flush would type into a
    // revoked (or respawned-but-never-rejoined) pane. Revocation must
    // hold even against event reordering.
    if (!room.isMember(terminalId)) {
      forget(terminalId)
      return
    }
    const now = Date.now()
    const since = waitingSince.get(terminalId) ?? now
    // Output-idle is not enough: the user may be mid-line in this very pane,
    // and typing a nudge into it would corrupt what they are writing — or the
    // agent may be sitting on a permission prompt, which is output-idle too,
    // and the flush's Enter would approve it. Hold the queue (never drop it)
    // and re-arm. These reasons have no maximum hold on purpose — see
    // `deliveryHoldReason`; only the output gate below has a safety valve.
    let reason = holdReason(terminalId)
    if (reason === null && busy) {
      const agent = useAgentStateStore.getState().byId[terminalId]
      const ready = busyPaneReady(
        {
          agentState: agent?.state,
          agentSinceMs: agent?.sinceMs,
          outputBytesPerSec: paneOutputRate(terminalId),
          waitingSinceMs: since,
          forced: forced.has(terminalId)
        },
        now
      )
      if (!ready) reason = 'pane-busy'
    }
    if (reason !== null) {
      // "Deliver now" waives the output gate for THIS attempt only: held for
      // another reason, the click is spent, not carried to a later recheck.
      if (reason !== 'pane-busy') forced.delete(terminalId)
      // A busy poll shows its hold only once the wait outlived the normal
      // countdown, so a nudge that goes out a second later never flashes ⏸.
      if (
        reason !== 'pane-busy' ||
        now - since >= NUDGE_IDLE_MS ||
        useWarRoomStore.getState().held[terminalId] !== undefined
      ) {
        setHeldLogged(terminalId, reason)
      }
      schedule(terminalId, HOLD_RECHECK_MS)
      return
    }
    setHeldLogged(terminalId, null)
    forget(terminalId)
    const payloads = useWarRoomStore.getState().takeFlush(terminalId)
    // Multiple payloads in one flush must not interleave their body and
    // Enter writes — deliver payload 0, submit it, only THEN deliver
    // payload 1 — or the agent could see a second paste land while it's
    // still deciding whether the first Enter was a real keypress.
    // Staggered on one clock: payload i's body goes at i*2*SUBMIT_DELAY_MS,
    // its submit at (i*2+1)*SUBMIT_DELAY_MS. No membership re-check per
    // stagger step — `isMember` was already checked above for this
    // flush, and each write's own `entries.get` guard (in
    // deliverPromptToTerminal/submitTerminalPrompt) covers the pane
    // being disposed out from under a pending write.
    payloads.forEach((text, i) => {
      const deliverTimer = setTimeout(
        () => {
          pending.delete(deliverTimer)
          deliverPromptToTerminal(terminalId, text)
        },
        i * 2 * SUBMIT_DELAY_MS
      )
      const submitTimer = setTimeout(
        () => {
          pending.delete(submitTimer)
          submitTerminalPrompt(terminalId)
        },
        (i * 2 + 1) * SUBMIT_DELAY_MS
      )
      pending.add(deliverTimer)
      pending.add(submitTimer)
    })
  }

  const unsubQueues = useWarRoomStore.subscribe((state, prev) => {
    if (state.queues === prev.queues) return
    for (const terminalId of Object.keys(state.queues)) schedule(terminalId)
  })

  const unsubActivity = useTerminalActivityStore.subscribe((state, prev) => {
    if (state.active === prev.active) return
    for (const terminalId of Object.keys(useWarRoomStore.getState().queues)) {
      // Either edge restarts the timer: a burst mid-countdown aborts the
      // strict countdown and arms the busy poll; the idle edge starts a
      // fresh strict countdown. Only this terminal's own edge — another
      // pane's output must not restart this queue's timer.
      if ((state.active[terminalId] ?? false) === (prev.active[terminalId] ?? false)) {
        schedule(terminalId)
        continue
      }
      cancel(terminalId)
      schedule(terminalId)
    }
  })

  const unsubTyping = useTerminalTypingStore.subscribe((state, prev) => {
    if (state.dirty === prev.dirty && state.lastKeyAt === prev.lastKeyAt) return
    // ONLY already-held terminals are woken. A queue still inside its normal
    // idle countdown must keep waiting — a keystroke in some other pane must
    // never short-circuit it into delivering early.
    const { held } = useWarRoomStore.getState()
    for (const terminalId of Object.keys(held)) {
      if (holdReason(terminalId) === null) {
        cancel(terminalId)
        schedule(terminalId, 0)
      }
    }
  })

  // Third wake-up source: the engine flipping blocked/working → idle. Same
  // held-only rule as the typing subscription — a queue still inside its idle
  // countdown keeps waiting. `schedule(id, 0)` still passes the activity gate,
  // and the detector's own working→idle debounce (pending-idle.ts) means
  // "idle" here is already a settled verdict, not a blink between two chunks.
  const unsubAgentState = useAgentStateStore.subscribe((state, prev) => {
    if (state.byId === prev.byId) return
    const { held } = useWarRoomStore.getState()
    for (const terminalId of Object.keys(held)) {
      if (holdReason(terminalId) === null) {
        cancel(terminalId)
        schedule(terminalId, 0)
      }
    }
  })

  return () => {
    unsubQueues()
    unsubActivity()
    unsubTyping()
    unsubAgentState()
    // Only our own handler: a second scheduler started meanwhile keeps its.
    if (deliverNowHandler === onDeliverNow) deliverNowHandler = null
    waitingSince.clear()
    forced.clear()
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    for (const t of pending) clearTimeout(t)
    pending.clear()
  }
}

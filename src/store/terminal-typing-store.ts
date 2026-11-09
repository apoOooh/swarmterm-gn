import { create } from 'zustand'
import { classifyInput } from '@/lib/terminal-typing'

/**
 * Per-terminal "the user is typing here" signal, keyed by terminalId. Runtime
 * state OUTSIDE the layout tree, exactly like terminal-activity-store (which
 * tracks pty OUTPUT — this one tracks user INPUT, and the War Room delivery
 * scheduler needs both: a pane can be output-idle and still mid-sentence).
 *
 * Written from `sendInput` in terminal-registry, the single place that sees
 * genuine user input. War Room deliveries write through `writeTerminal`
 * directly and never reach that hook, so a nudge can never mark its own
 * recipient as "the user is typing".
 */
export interface TerminalTypingStore {
  /** ms epoch of the last input of any kind, per terminal. */
  lastKeyAt: Record<string, number>
  /** True while a line has been typed and not yet submitted or abandoned. */
  dirty: Record<string, boolean>
  /**
   * SWA-88: the user's last real submit — a plain Enter KEY whose `\r`
   * reached `sendInput` (`keyboardEnter`, see `createSubmitIntent`), with the
   * input revision right after it. Bytes alone never make one: LF
   * (Shift+Enter, Ctrl+J), pastes and xterm's protocol answers do not.
   * Program writes (War Room, dictation, the resubmit itself) never reach
   * `noteInput` at all. Taken once by `takeSubmit`.
   *
   * Broadcast: the fan-out calls `noteInput` per target with the source's
   * intent, so an armed member gets an anchor too. Deliberate — the user's
   * Enter really was written into that pane and sent the same line there.
   */
  submitAnchor: Record<string, { at: number; rev: number }>
  /**
   * SWA-88: per-pane input revision. Every real input (`noteInput`, any
   * payload, Esc / Ctrl+C / Enter included) and every `clearTyping` (the
   * clear-input shortcut, Deliver now, respawn, dispose) moves it to a new
   * value from one global counter: it never goes back, not even after a
   * clear or a dispose of the same id, so "unchanged since X" really means
   * no input since X. `markDraft` (our own writes) leaves it alone.
   */
  inputRev: Record<string, number>
  /** `keyboardEnter`: this payload is the `\r` of a plain Enter keydown. */
  noteInput: (terminalId: string, data: string, keyboardEnter?: boolean) => void
  /** "Done typing here" — used by the Deliver-now buttons, by pane disposal,
   *  and by `noteInput` itself on a submit, all of which want the same thing:
   *  drop this terminal's entries (and move its revision on). */
  clearTyping: (terminalId: string) => void
  /** Voice dictation wrote a draft into this pane: it now holds the user's
   *  unsubmitted line, exactly as if typed. Returns the `lastKeyAt` stamp so
   *  the delayed Enter can tell whether the user touched the line since. */
  markDraft: (terminalId: string, nowMs: number) => number
  /** Consume the submit anchor if it is at most `maxAgeMs` old (SWA-88):
   *  its input revision, or undefined when there is none. */
  takeSubmit: (terminalId: string, nowMs: number, maxAgeMs: number) => number | undefined
}

/** Monotonic across all panes and the whole process. */
let revCounter = 0

export const useTerminalTypingStore = create<TerminalTypingStore>((set, get) => ({
  lastKeyAt: {},
  dirty: {},
  submitAnchor: {},
  inputRev: {},

  noteInput: (terminalId, data, keyboardEnter = false) => {
    const kind = classifyInput(data)
    if (kind === 'submit') {
      // "The line is done, nothing pending in this pane" is exactly what
      // clearTyping means, so share its logic rather than duplicating it.
      // Clearing lastKeyAt (not just dirty) matters: leaving it stamped would
      // mean the user — who is by definition focused in this pane right after
      // pressing Enter — re-arms shouldDeferDelivery's focused-and-recent arm
      // on every submit, holding the pane for a further TYPING_QUIET_MS when
      // the line it was guarding no longer exists. clearTyping also moves the
      // revision on and drops an older anchor: a new submit ends an attempt
      // that was riding on the previous one.
      get().clearTyping(terminalId)
      if (keyboardEnter && data === '\r') {
        const rev = get().inputRev[terminalId] ?? 0
        set((s) => ({ submitAnchor: { ...s.submitAnchor, [terminalId]: { at: Date.now(), rev } } }))
      }
      return
    }
    set((s) => {
      const lastKeyAt = { ...s.lastKeyAt, [terminalId]: Date.now() }
      const inputRev = { ...s.inputRev, [terminalId]: ++revCounter }
      // Navigation moves the cursor without changing the line, so it refreshes
      // recency but must not clear a half-typed line.
      if (kind === 'nav') return { lastKeyAt, inputRev }
      return { lastKeyAt, inputRev, dirty: { ...s.dirty, [terminalId]: true } }
    })
  },

  markDraft: (terminalId, nowMs) => {
    set((s) => ({
      lastKeyAt: { ...s.lastKeyAt, [terminalId]: nowMs },
      dirty: { ...s.dirty, [terminalId]: true }
    }))
    return nowMs
  },

  takeSubmit: (terminalId, nowMs, maxAgeMs) => {
    const anchor = get().submitAnchor[terminalId]
    if (anchor === undefined) return undefined
    set((s) => {
      const submitAnchor = { ...s.submitAnchor }
      delete submitAnchor[terminalId]
      return { submitAnchor }
    })
    const age = nowMs - anchor.at
    return age >= 0 && age <= maxAgeMs ? anchor.rev : undefined
  },

  // Also drops the submit anchor: disposal, retry and respawn call this, so
  // an anchor never outlives the generation it was typed into. The revision
  // is moved on, never removed — a clear is input too, and an attempt that
  // captured the old value must see that something happened.
  clearTyping: (terminalId) =>
    set((s) => {
      // Maps without this id keep their identity: subscribers of `dirty` /
      // `lastKeyAt` must not re-render for a pane that never typed.
      const without = <T,>(m: Record<string, T>): Record<string, T> => {
        if (!(terminalId in m)) return m
        const next = { ...m }
        delete next[terminalId]
        return next
      }
      return {
        dirty: without(s.dirty),
        lastKeyAt: without(s.lastKeyAt),
        submitAnchor: without(s.submitAnchor),
        inputRev: { ...s.inputRev, [terminalId]: ++revCounter }
      }
    })
}))

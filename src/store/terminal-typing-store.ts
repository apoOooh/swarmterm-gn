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
   * SWA-88: ms epoch of the user's last real submit (a key payload carrying
   * Enter, seen by `sendInput`). Program writes (War Room, dictation, the
   * resubmit itself) never reach `noteInput`, so a process in the pane
   * cannot create one. Taken once by `takeSubmit`.
   */
  submittedAt: Record<string, number>
  noteInput: (terminalId: string, data: string) => void
  /** "Done typing here" — used by the Deliver-now buttons, by pane disposal,
   *  and by `noteInput` itself on a submit, all of which want the same thing:
   *  drop this terminal's entries. */
  clearTyping: (terminalId: string) => void
  /** Voice dictation wrote a draft into this pane: it now holds the user's
   *  unsubmitted line, exactly as if typed. Returns the `lastKeyAt` stamp so
   *  the delayed Enter can tell whether the user touched the line since. */
  markDraft: (terminalId: string, nowMs: number) => number
  /** Consume the submit stamp if it is at most `maxAgeMs` old (SWA-88). */
  takeSubmit: (terminalId: string, nowMs: number, maxAgeMs: number) => boolean
}

/** A payload that really sent a line: Enter, alone or at the end of a chord
 *  or an unframed paste. Ctrl+C / Ctrl+U / Esc also end the line
 *  (`classifyInput` 'submit') but send nothing. */
export function isRealSubmit(data: string): boolean {
  return data.includes('\r') || data.includes('\n')
}

export const useTerminalTypingStore = create<TerminalTypingStore>((set, get) => ({
  lastKeyAt: {},
  dirty: {},
  submittedAt: {},

  noteInput: (terminalId, data) => {
    const kind = classifyInput(data)
    if (kind === 'submit') {
      // "The line is done, nothing pending in this pane" is exactly what
      // clearTyping means, so share its logic rather than duplicating it.
      // Clearing lastKeyAt (not just dirty) matters: leaving it stamped would
      // mean the user — who is by definition focused in this pane right after
      // pressing Enter — re-arms shouldDeferDelivery's focused-and-recent arm
      // on every submit, holding the pane for a further TYPING_QUIET_MS when
      // the line it was guarding no longer exists.
      get().clearTyping(terminalId)
      if (isRealSubmit(data)) {
        set((s) => ({ submittedAt: { ...s.submittedAt, [terminalId]: Date.now() } }))
      }
      return
    }
    set((s) => {
      const lastKeyAt = { ...s.lastKeyAt, [terminalId]: Date.now() }
      // Navigation moves the cursor without changing the line, so it refreshes
      // recency but must not clear a half-typed line.
      if (kind === 'nav') return { lastKeyAt }
      return { lastKeyAt, dirty: { ...s.dirty, [terminalId]: true } }
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
    const at = get().submittedAt[terminalId]
    if (at === undefined) return false
    set((s) => {
      const submittedAt = { ...s.submittedAt }
      delete submittedAt[terminalId]
      return { submittedAt }
    })
    return nowMs - at >= 0 && nowMs - at <= maxAgeMs
  },

  // Also drops the submit stamp: disposal, retry and respawn call this, so
  // a stamp never outlives the generation it was typed into.
  clearTyping: (terminalId) =>
    set((s) => {
      if (!(terminalId in s.dirty) && !(terminalId in s.lastKeyAt) && !(terminalId in s.submittedAt)) return s
      const dirty = { ...s.dirty }
      const lastKeyAt = { ...s.lastKeyAt }
      const submittedAt = { ...s.submittedAt }
      delete dirty[terminalId]
      delete lastKeyAt[terminalId]
      delete submittedAt[terminalId]
      return { dirty, lastKeyAt, submittedAt }
    })
}))

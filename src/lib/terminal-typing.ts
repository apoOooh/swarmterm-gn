/**
 * Classifies one `onData` payload from xterm — one piece of genuine user
 * input — so the War Room nudge guard can tell "mid-line" from "line
 * finished". Pure; the store applies the result and the delivery scheduler
 * reads it. See `shouldDeferDelivery` in war-room-nudge.ts.
 */
export type InputKind = 'edit' | 'submit' | 'nav'

/** Lone control codes that commit or abandon the current line. `\x1b` here is
 *  Esc pressed on its own — an escape SEQUENCE starts with the same byte and
 *  is handled below, which is the one distinction this module exists for.
 *  LF is NOT one of them (SWA-88): Shift+Enter in an agent pane sends it
 *  (`AGENT_NEWLINE`), and so does Ctrl+J — a line break inside the draft,
 *  which leaves the line unsent. Holding a delivery for a bash Ctrl+J that
 *  did run a line is the safe direction. */
const LINE_ENDING_CODES = new Set(['\r', '\x03', '\x15', '\x1b'])

/** The frame xterm's `paste()` emits when the foreground app has enabled
 *  bracketed paste (DECSET 2004) — every agent TUI does, and so do zsh/bash by
 *  default. xterm hands the WHOLE clipboard over as ONE `onData` payload with
 *  `\n` already normalised to `\r`, so a frame never straddles two calls and
 *  this stays stateless. Strict on BOTH markers: a payload that merely starts
 *  with the opener is an ordinary escape sequence, not a paste. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export function isBracketedPaste(data: string): boolean {
  return data.startsWith(PASTE_START) && data.endsWith(PASTE_END)
}

export function classifyInput(data: string): InputKind {
  if (data === '') return 'nav'
  // Bracketed paste is the one ESC-prefixed payload that CHANGES the line, and
  // the CRs inside the frame are inert — not executing them is the entire
  // point of the mode. Without this arm a pasted `deploy prod` reads as
  // navigation (dirty never set) and a two-line paste reads as a submit
  // (dirty CLEARED) while the text is still sitting unsent on the line, so a
  // War Room nudge would be typed over it. The inner text is irrelevant: the
  // app inserts it literally, which is by definition an unsubmitted line. An
  // empty frame cannot occur (the Ctrl/Cmd+V path gates on non-empty text)
  // and over-holding is this module's safe direction, so it is `edit` too.
  if (isBracketedPaste(data)) return 'edit'
  if (LINE_ENDING_CODES.has(data)) return 'submit'
  // A CR anywhere means at least one line was committed — an UNFRAMED
  // multi-line paste (bracketed paste off — the shell really runs each line;
  // xterm's paste normalises LF to CR), or a chord whose payload ends in
  // Enter. A bare LF only breaks the line (see LINE_ENDING_CODES).
  if (data.includes('\r')) return 'submit'
  // Arrows, Home/End, function keys: they move the cursor without changing
  // what is on the line, so they refresh the "recently active" timestamp but
  // must not clear the dirty flag.
  if (data.startsWith('\x1b')) return 'nav'
  // Everything else edits the line, backspace included. Backspacing a line
  // down to empty still counts as dirty — we cannot see the line's contents,
  // and over-holding a delivery is the safe direction to err in. Esc clears it.
  return 'edit'
}

type EnterKeyLike = Pick<KeyboardEvent, 'type' | 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'> & {
  isComposing?: boolean
}

/** Enter with no modifier and outside an IME composition: the key that sends a line. */
export function isPlainEnter(event: EnterKeyLike): boolean {
  return (
    event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing
  )
}

/**
 * SWA-88: "the user pressed Enter" taken from the KEY, not from the bytes.
 * `onData` carries more than keystrokes: xterm's own answers to DA/DSR/colour
 * queries, pastes (a CR inside an unframed paste), Ctrl+J, and our
 * Shift+Enter newline. Only a plain Enter keydown that xterm went on to
 * handle arms this, and only the CR that very keydown emits (xterm emits it
 * synchronously inside the same event) takes it. Anything else — another
 * payload, the next keydown, the end of the current task — disarms it, so a
 * keydown xterm did not turn into data cannot lend its intent to a later
 * paste or reply.
 */
export interface SubmitIntent {
  /** Every key event xterm's custom handler sees; `passed` = it returned true. */
  key: (event: EnterKeyLike, passed: boolean) => void
  /** Every `onData` payload, before it is recorded: true = a real Enter. */
  take: (data: string) => boolean
}

const CR = String.fromCharCode(13)

export function createSubmitIntent(): SubmitIntent {
  let armed = false
  return {
    key: (event, passed) => {
      if (event.type !== 'keydown') return
      armed = passed && isPlainEnter(event)
      if (armed) {
        queueMicrotask(() => {
          armed = false
        })
      }
    },
    take: (data) => {
      const real = armed && data === CR
      armed = false
      return real
    }
  }
}

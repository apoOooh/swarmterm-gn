/**
 * Stop rules for built-in announcements (SWA-66). Typing means the user is
 * busy with something else: the voice stops at the FIRST keystroke, not
 * after a pause (leading edge), and further keystrokes within the window
 * don't each cost an IPC call. Stopping is idempotent in Rust, so a stop
 * with nothing playing is harmless.
 */
export const TTS_STOP_THROTTLE_MS = 250

export function createTtsStopper(stop: () => void, now: () => number = Date.now): () => void {
  let last = Number.NEGATIVE_INFINITY
  return () => {
    const t = now()
    if (t - last < TTS_STOP_THROTTLE_MS) return
    last = t
    stop()
  }
}

/**
 * The pane that just gained focus, if focus moved to a different terminal.
 * Its announcement is moot — the user is looking at it.
 */
export function newlyFocusedTerminal(prev: string | null | undefined, next: string | null | undefined): string | null {
  return next && next !== prev ? next : null
}

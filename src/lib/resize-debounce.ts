/**
 * Trailing debounce for pty resizes. xterm itself is re-fitted on every
 * ResizeObserver tick (the pane must never paint clipped), but the pty only
 * hears the size once the drag settles: each pushed size makes ConPTY
 * repaint and the TUI (Claude Code, Codex) redraw for it, and a burst of
 * redraws racing xterm's own reflow is what leaves stale fragments behind.
 * Only the LAST size is ever sent, and nothing at all when it ends where the
 * pty already is.
 */
export const PTY_RESIZE_DEBOUNCE_MS = 100

export interface ResizeDebounceDeps {
  send: (cols: number, rows: number) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface ResizeDebouncer {
  /** Queue a size; the newest one wins. */
  schedule: (cols: number, rows: number) => void
  /** Send now, bypassing the wait (attach, respawn); cancels anything queued. */
  flush: (cols: number, rows: number) => void
  /** Drop a queued size (detach/dispose). */
  cancel: () => void
}

export function createResizeDebouncer(deps: ResizeDebounceDeps): ResizeDebouncer {
  let timer: unknown
  let queued: { cols: number; rows: number } | undefined
  let sent: { cols: number; rows: number } | undefined

  const cancel = (): void => {
    if (timer !== undefined) deps.clearTimer(timer)
    timer = undefined
    queued = undefined
  }

  const send = (cols: number, rows: number): void => {
    sent = { cols, rows }
    deps.send(cols, rows)
  }

  return {
    schedule: (cols, rows) => {
      queued = { cols, rows }
      if (timer !== undefined) deps.clearTimer(timer)
      timer = deps.setTimer(() => {
        timer = undefined
        const q = queued
        queued = undefined
        if (q === undefined || (sent !== undefined && sent.cols === q.cols && sent.rows === q.rows)) return
        send(q.cols, q.rows)
      }, PTY_RESIZE_DEBOUNCE_MS)
    },
    flush: (cols, rows) => {
      cancel()
      send(cols, rows)
    },
    cancel
  }
}

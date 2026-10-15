/**
 * Coalesce work to at most once per item per animation frame.
 *
 * ResizeObservers fire on every layout pass; during a sidebar drag or a split
 * resize that is every frame for every terminal, and running xterm's fit()
 * synchronously inside each callback stacks N measure + reflow + redraw passes
 * into one frame. Batching them here runs every dirty item in a single frame
 * callback, after the layout has settled for that frame.
 */
export interface FrameBatch<T> {
  schedule(item: T): void
  /** Drop a pending item (e.g. a terminal detached before the frame fired). */
  cancel(item: T): void
}

export function createFrameBatch<T>(
  run: (item: T) => void,
  raf: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb)
): FrameBatch<T> {
  const dirty = new Set<T>()
  let requested = false

  const flush = (): void => {
    requested = false
    const items = [...dirty]
    dirty.clear()
    for (const item of items) {
      // One bad item must not starve the rest of the frame.
      try {
        run(item)
      } catch (e) {
        console.error(e)
      }
    }
  }

  return {
    schedule(item) {
      dirty.add(item)
      if (!requested) {
        requested = true
        raf(flush)
      }
    },
    cancel(item) {
      dirty.delete(item)
    }
  }
}

/**
 * Cleanup for a Tauri listener whose unlisten function arrives asynchronously.
 * If the effect is torn down before the promise resolves, the listener is
 * removed as soon as it does (same pattern as FileDropListener). A rejected
 * registration is logged instead of surfacing as an unhandled rejection.
 */
export function cleanupWhenResolved(pending: Promise<() => void>, label = 'listener'): () => void {
  let cancelled = false
  let unlisten: (() => void) | undefined
  pending.then(
    (fn) => {
      if (cancelled) fn()
      else unlisten = fn
    },
    (e) => console.warn(`[${label}] failed to register:`, e)
  )
  return () => {
    cancelled = true
    unlisten?.()
  }
}

/**
 * Tracks the latest of a series of async requests: `begin()` returns a
 * predicate that is true only while that request is still the newest one and
 * the owner has not been disposed.
 */
export function latestRequest(): { begin: () => () => boolean; dispose: () => void } {
  let current = 0
  let disposed = false
  return {
    begin: () => {
      const id = ++current
      disposed = false
      return () => !disposed && id === current
    },
    dispose: () => {
      disposed = true
    }
  }
}

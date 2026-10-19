/**
 * Global budget for live WebGL contexts (one per terminal on the GPU renderer).
 *
 * Every WebglAddon holds a WebGL2 context plus a glyph texture atlas, and
 * Chromium/WebView2 caps live contexts at ~16 per page, silently killing the
 * oldest beyond that. Holding contexts for panes nobody can see (hidden
 * workspaces, drawered or zoomed-away panes) is the bulk of the renderer's GPU
 * and WebView memory. The registry asks this budget before attaching an addon;
 * when the budget is full, the least recently visible holder is evicted (its
 * pane falls back to the DOM renderer) instead of the browser picking a victim.
 *
 * Pure bookkeeping — no DOM, no xterm — so the LRU rules are unit-testable.
 */
export const WEBGL_CONTEXT_BUDGET = 12

export interface WebglBudget<K> {
  /**
   * Mark `key` as visible right now and reserve a slot for it. Returns true when
   * the caller may hold (or keep) a context. A new holder in a full budget
   * evicts the least recently visible other holder, via `evict`, first.
   */
  acquire: (key: K) => boolean
  /** Free `key`'s slot (pane hidden, detached, disposed or context lost). */
  release: (key: K) => void
  has: (key: K) => boolean
  size: () => number
}

export function createWebglBudget<K>(
  max: number,
  evict: (key: K) => void
): WebglBudget<K> {
  // Map iteration order is insertion order: delete + re-set moves a key to the
  // most-recent end, so the first key is always the least recently visible.
  const holders = new Map<K, true>()

  return {
    acquire(key) {
      if (max <= 0) return false
      if (holders.has(key)) {
        holders.delete(key)
        holders.set(key, true)
        return true
      }
      while (holders.size >= max) {
        const oldest = holders.keys().next().value as K
        holders.delete(oldest)
        evict(oldest)
      }
      holders.set(key, true)
      return true
    },
    release(key) {
      holders.delete(key)
    },
    has: (key) => holders.has(key),
    size: () => holders.size
  }
}

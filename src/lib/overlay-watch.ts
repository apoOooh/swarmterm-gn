import { OVERLAY_SELECTOR } from './terminal-focus'

/**
 * A native child webview paints ABOVE every DOM element — a Radix menu or
 * dialog opened over the preview column would render underneath it. The fix is
 * to hide the webview while any overlay is open; this module is the "any
 * overlay is open" signal. Selector shared with terminal-focus.ts, which
 * already encodes which floating chrome owns the screen.
 */
export interface OverlayRoot {
  querySelector(selectors: string): unknown
}

/**
 * Floating chrome that must cover the webview but is NOT an overlay for focus
 * purposes (e.g. the peeking sidebar) renders a `[data-covers-webview]` marker.
 */
const WEBVIEW_COVER_SELECTOR = `${OVERLAY_SELECTOR},[data-covers-webview]`

export function hasOpenOverlay(root: OverlayRoot): boolean {
  return root.querySelector(WEBVIEW_COVER_SELECTOR) !== null
}

/**
 * DOM adapter: report overlay open/close transitions. Fires the callback
 * immediately with the current state so subscribers need no separate read.
 * The observer must stay subtree-wide: OVERLAY_SELECTOR also matches
 * non-portalled role=listbox/dialog elements deep in the tree. The check is
 * deliberately not deferred to a later frame — an open overlay must hide the
 * native webview before it paints, or the page covers the menu. The
 * querySelector per (microtask-batched) mutation record set is microseconds.
 */
export function watchOverlays(cb: (open: boolean) => void): () => void {
  let last = hasOpenOverlay(document)
  cb(last)
  const observer = new MutationObserver(() => {
    const now = hasOpenOverlay(document)
    if (now !== last) {
      last = now
      cb(now)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}

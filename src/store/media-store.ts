import { create } from 'zustand'
import { addMediaItem, type MediaItem } from '@/lib/media-gallery'
import { createAutoHide, overlayAllows, pushOverlayItem, type MediaOrigin } from '@/lib/media-overlay'
import { useMediaPrefStore } from '@/store/media-pref-store'

interface MediaState {
  /** Newest first, across all panes (each item names its source pane). */
  items: MediaItem[]
  selectedPath: string | null
  /** Passively detected items per source terminal the user has not looked at yet (pane badge). */
  unseen: Record<string, number>
  /** Auto-show overlay: the last N announced items (newest first) and whether it is up. */
  overlayItems: MediaItem[]
  overlayVisible: boolean
  show: (item: MediaItem) => void
  /**
   * A path found in pane output: joins the strip WITHOUT taking the viewer
   * (the user may be looking at something else) and counts toward the pane
   * badge. A path already in the gallery only moves to the front.
   */
  detect: (item: MediaItem) => void
  /** A clipboard image: joins the strip without taking the viewer, no pane badge. */
  add: (item: MediaItem) => void
  clearUnseen: (terminalId: string) => void
  select: (path: string) => void
  /** New media arrived; pops the overlay if the user's prefs allow it for this origin. */
  announce: (item: MediaItem, origin: MediaOrigin) => void
  dismissOverlay: () => void
}

const has = (items: MediaItem[], path: string): boolean => items.some((i) => i.path.toLowerCase() === path.toLowerCase())

/**
 * One timer for the app's single overlay. It lives beside the store, not in
 * the component, so an item announced while the overlay is unmounted (hidden)
 * still arms it, and the timeout is read from prefs at every arm.
 */
export const overlayAutoHide = createAutoHide(
  () => useMediaPrefStore.getState().prefs.overlayTimeoutSec * 1000,
  () => useMediaStore.setState({ overlayVisible: false }),
)

export const useMediaStore = create<MediaState>((set) => ({
  items: [],
  selectedPath: null,
  unseen: {},
  overlayItems: [],
  overlayVisible: false,
  show: (item) => set((s) => ({ items: addMediaItem(s.items, item), selectedPath: item.path })),
  detect: (item) => set((s) => {
    const fresh = !has(s.items, item.path)
    return {
      items: addMediaItem(s.items, item),
      selectedPath: s.selectedPath ?? item.path,
      unseen: fresh ? { ...s.unseen, [item.terminalId]: (s.unseen[item.terminalId] ?? 0) + 1 } : s.unseen,
    }
  }),
  add: (item) => set((s) => ({ items: addMediaItem(s.items, item), selectedPath: s.selectedPath ?? item.path })),
  clearUnseen: (terminalId) => set((s) => {
    if (!(terminalId in s.unseen)) return s
    const unseen = { ...s.unseen }
    delete unseen[terminalId]
    return { unseen }
  }),
  // Looking at a pane's detected item counts as having seen that pane's news.
  select: (path) => set((s) => {
    const item = s.items.find((i) => i.path === path)
    if (!item || !(item.terminalId in s.unseen)) return { selectedPath: path }
    const unseen = { ...s.unseen }
    delete unseen[item.terminalId]
    return { selectedPath: path, unseen }
  }),
  announce: (item, origin) => {
    const prefs = useMediaPrefStore.getState().prefs
    if (!overlayAllows(prefs, origin)) return
    set((s) => ({ overlayItems: pushOverlayItem(s.overlayItems, item, prefs.overlayMaxItems), overlayVisible: true }))
    overlayAutoHide.show()
  },
  dismissOverlay: () => {
    overlayAutoHide.stop()
    set({ overlayVisible: false })
  },
}))

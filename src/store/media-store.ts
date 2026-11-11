import { create } from 'zustand'
import { addMediaItem, markOpened, samePath, type MediaItem } from '@/lib/media-gallery'
import { createAutoHide, overlayAllows, pushOverlayItem, type MediaOrigin } from '@/lib/media-overlay'
import { useMediaPrefStore } from '@/store/media-pref-store'
import { registerOpenedMedia } from '@/tauri/files'

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
   * badge. A path already in the gallery moves to the front (one updated
   * entry, no history per version) and counts as news again when its
   * `version` changed (the file was overwritten); the same version is a
   * no-op. An unopened item is registered for serving right away so the
   * strip shows its thumbnail (user decision 2026-10-29: no click-to-load
   * gate). Returns whether the item is news (worth announcing).
   */
  detect: (item: MediaItem) => boolean
  /** A clipboard image: joins the strip without taking the viewer, no pane badge. */
  add: (item: MediaItem) => void
  clearUnseen: (terminalId: string) => void
  select: (path: string) => void
  /**
   * User action on an item (strip, overlay, pane badge): registers it for
   * serving if needed, then selects it. Resolves false when the file can no
   * longer be opened (gone, replaced by a non-media file, cap reached).
   */
  open: (path: string) => Promise<boolean>
  /** New media arrived; pops the overlay if the user's prefs allow it for this origin. */
  announce: (item: MediaItem, origin: MediaOrigin) => void
  dismissOverlay: () => void
  /** Clipboard images switched off: the backend deleted/withdrew them, so drop them here too. */
  dropClipboard: () => void
}

/** `source` of clipboard items (App.tsx sets it). */
export const CLIPBOARD_SOURCE = 'clipboard'

/**
 * Registers a path for serving unless it is already known opened, then marks
 * it opened everywhere. False (and the item dropped, so it is not offered
 * again) when the file is gone, no longer media, or the cap is reached.
 */
async function register(path: string): Promise<boolean> {
  const { items, overlayItems } = useMediaStore.getState()
  // An overlay row may outlive its strip entry (strip cap): register unless known opened.
  if ([...items, ...overlayItems].some((i) => i.opened && samePath(i.path, path))) return true
  try {
    await registerOpenedMedia(path)
  } catch (err) {
    console.warn('[media] open:', err)
    useMediaStore.setState((s) => ({
      items: s.items.filter((i) => !samePath(i.path, path)),
      overlayItems: s.overlayItems.filter((i) => !samePath(i.path, path)),
      selectedPath: s.selectedPath !== null && samePath(s.selectedPath, path) ? null : s.selectedPath,
    }))
    return false
  }
  useMediaStore.setState((s) => ({ items: markOpened(s.items, path), overlayItems: markOpened(s.overlayItems, path) }))
  return true
}

/**
 * One timer for the app's single overlay. It lives beside the store, not in
 * the component, so an item announced while the overlay is unmounted (hidden)
 * still arms it, and the timeout is read from prefs at every arm.
 */
export const overlayAutoHide = createAutoHide(
  () => useMediaPrefStore.getState().prefs.overlayTimeoutSec * 1000,
  () => useMediaStore.setState({ overlayVisible: false }),
)

export const useMediaStore = create<MediaState>((set, get) => ({
  items: [],
  selectedPath: null,
  unseen: {},
  overlayItems: [],
  overlayVisible: false,
  show: (item) => set((s) => ({ items: addMediaItem(s.items, item), selectedPath: item.path })),
  detect: (item) => {
    const old = get().items.find((i) => samePath(i.path, item.path))
    // Two spellings of one file, both found with the same stamp: nothing new.
    if (old && item.version !== undefined && old.version === item.version) return false
    // An entry without a version (user-shown, clipboard) adopts the stamp
    // silently: the user already has that file, so no badge or announce.
    const news = !old || (old.version !== undefined && item.version !== undefined && old.version !== item.version)
    set((s) => ({
      items: addMediaItem(s.items, item),
      selectedPath: s.selectedPath ?? item.path,
      unseen: news ? { ...s.unseen, [item.terminalId]: (s.unseen[item.terminalId] ?? 0) + 1 } : s.unseen,
    }))
    if (!item.opened) void register(item.path)
    return news
  },
  add: (item) => set((s) => ({ items: addMediaItem(s.items, item), selectedPath: s.selectedPath ?? item.path })),
  clearUnseen: (terminalId) => set((s) => {
    if (!(terminalId in s.unseen)) return s
    const unseen = { ...s.unseen }
    delete unseen[terminalId]
    return { unseen }
  }),
  // Looking at a pane's detected item counts as having seen that pane's news.
  select: (path) => set((s) => {
    const item = s.items.find((i) => samePath(i.path, path))
    if (!item || !(item.terminalId in s.unseen)) return { selectedPath: path }
    const unseen = { ...s.unseen }
    delete unseen[item.terminalId]
    return { selectedPath: path, unseen }
  }),
  open: async (path) => {
    if (!(await register(path))) return false
    useMediaStore.getState().select(path)
    return true
  },
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
  dropClipboard: () => set((s) => {
    // Pane items always carry a terminalId, so a pane named "clipboard" stays.
    const keep = (i: MediaItem): boolean => !(i.terminalId === '' && i.source === CLIPBOARD_SOURCE)
    const items = s.items.filter(keep)
    const selectedPath = s.selectedPath !== null && items.some((i) => samePath(i.path, s.selectedPath!)) ? s.selectedPath : null
    return { items, overlayItems: s.overlayItems.filter(keep), selectedPath }
  }),
}))

import { create } from 'zustand'
import { addMediaItem, type MediaItem } from '@/lib/media-gallery'

interface MediaState {
  /** Newest first, across all panes (each item names its source pane). */
  items: MediaItem[]
  selectedPath: string | null
  /** Passively detected items per source terminal the user has not looked at yet (pane badge). */
  unseen: Record<string, number>
  show: (item: MediaItem) => void
  /**
   * A path found in pane output: joins the strip WITHOUT taking the viewer
   * (the user may be looking at something else) and counts toward the pane
   * badge. A path already in the gallery only moves to the front.
   */
  detect: (item: MediaItem) => void
  clearUnseen: (terminalId: string) => void
  select: (path: string) => void
}

const has = (items: MediaItem[], path: string): boolean => items.some((i) => i.path.toLowerCase() === path.toLowerCase())

export const useMediaStore = create<MediaState>((set) => ({
  items: [],
  selectedPath: null,
  unseen: {},
  show: (item) => set((s) => ({ items: addMediaItem(s.items, item), selectedPath: item.path })),
  detect: (item) => set((s) => {
    const fresh = !has(s.items, item.path)
    return {
      items: addMediaItem(s.items, item),
      selectedPath: s.selectedPath ?? item.path,
      unseen: fresh ? { ...s.unseen, [item.terminalId]: (s.unseen[item.terminalId] ?? 0) + 1 } : s.unseen,
    }
  }),
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
}))

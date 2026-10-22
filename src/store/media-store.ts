import { create } from 'zustand'
import { addMediaItem, type MediaItem } from '@/lib/media-gallery'

interface MediaState {
  /** Newest first, across all panes (each item names its source pane). */
  items: MediaItem[]
  selectedPath: string | null
  show: (item: MediaItem) => void
  select: (path: string) => void
}

export const useMediaStore = create<MediaState>((set) => ({
  items: [],
  selectedPath: null,
  show: (item) => set((s) => ({ items: addMediaItem(s.items, item), selectedPath: item.path })),
  select: (path) => set({ selectedPath: path }),
}))

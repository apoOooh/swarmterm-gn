import { fileKind } from '@/lib/files/tree'

/** One file an agent showed via `media.show`; served by the unrooted media route. */
export interface MediaItem {
  path: string
  kind: 'image' | 'video'
  terminalId: string
  /** Pane label captured at show time — the pane may be gone later. */
  source: string
  shownAt: number
}

/** Agents re-show the same file while iterating; keep the strip bounded. */
export const MEDIA_GALLERY_MAX = 100

const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export function mediaKind(path: string): 'image' | 'video' | null {
  const kind = fileKind(path)
  return kind === 'text' ? null : kind
}

/**
 * Newest first. Re-showing a path moves it to the front with a fresh
 * `shownAt` (which doubles as the cache-busting revision, so an updated
 * screenshot reloads) instead of duplicating it.
 */
export function addMediaItem(items: MediaItem[], item: MediaItem, max = MEDIA_GALLERY_MAX): MediaItem[] {
  return [item, ...items.filter((i) => !samePath(i.path, item.path))].slice(0, max)
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

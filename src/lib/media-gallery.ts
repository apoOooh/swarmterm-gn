import { fileKind } from '@/lib/files/tree'

/** One gallery file; served by the unrooted media route once the user opened it. */
export interface MediaItem {
  path: string
  kind: 'image' | 'video'
  terminalId: string
  /** Pane label captured at show time — the pane may be gone later. */
  source: string
  shownAt: number
  /**
   * Registered for serving. Pane-output detection never registers (agents
   * control what a pane prints); only a user action does, so until then the
   * UI shows the name and a placeholder and never requests the file.
   */
  opened: boolean
}

/** Agents re-show the same file while iterating; keep the strip bounded. */
export const MEDIA_GALLERY_MAX = 100

export const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

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
  // Re-detecting a file the user already opened keeps it opened.
  const opened = item.opened || items.some((i) => i.opened && samePath(i.path, item.path))
  return [{ ...item, opened }, ...items.filter((i) => !samePath(i.path, item.path))].slice(0, max)
}

/** Marks every entry for `path` as registered (gallery strip and overlay list). */
export function markOpened(items: MediaItem[], path: string): MediaItem[] {
  return items.map((i) => (samePath(i.path, path) && !i.opened ? { ...i, opened: true } : i))
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

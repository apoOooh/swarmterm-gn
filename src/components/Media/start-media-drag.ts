import { insertIntoPane } from '@/components/FileDropListener'
import { mediaDragOptions, mediaGhost } from '@/lib/media-drag'
import { samePath, type MediaItem } from '@/lib/media-gallery'
import { startPointerDrag } from '@/lib/pointer-drag-session'
import { useMediaStore } from '@/store/media-store'
import { unrootedMediaUrl } from '@/tauri/files'

// insertIntoPane lives with the other pane-drop writers (FileDropListener) so
// every drag into a pane shares one paste + focus path; the rules stay
// injectable in lib/media-drag.ts.
/** Wires a thumbnail's pointerdown to the media drag (rules in lib/media-drag.ts). */
export function startMediaDrag(down: { button: number; clientX: number; clientY: number }, item: MediaItem, onTap: () => void): void {
  const kind = mediaGhost(item)
  const isKnown = (path: string): boolean => {
    const { items, overlayItems } = useMediaStore.getState()
    return [...items, ...overlayItems].some((i) => samePath(i.path, path))
  }
  startPointerDrag(down, {
    ...mediaDragOptions(item.path, {
      elementAt: (x, y) => document.elementFromPoint(x, y) as HTMLElement | null,
      isKnown,
      insert: insertIntoPane,
      onTap,
    }),
    // Only an opened image is already served; anything else gets an icon so
    // the drag never fetches (or registers) a file the user has not opened.
    ghost: kind === 'thumb' ? { url: unrootedMediaUrl(item.path, item.shownAt) } : { icon: kind === 'film' ? 'film' : 'image' },
  })
}

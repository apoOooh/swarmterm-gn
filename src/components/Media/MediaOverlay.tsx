/**
 * Auto-show overlay: a corner popup listing the newest media (Settings →
 * Media, off by default). Rules that are easy to break:
 * - It never takes the keyboard. Every control is tabIndex -1 with
 *   mousedown swallowed, and the root carries data-focus-return so App hands
 *   focus back to the terminal after a click.
 * - Esc is claimed ONLY while the pointer is over the popup: agents use Esc
 *   to interrupt, so a global Esc handler would eat the user's keystroke.
 * - Native preview webviews paint over all DOM, so the root carries
 *   data-covers-webview (lib/overlay-watch.ts) and the preview hides while
 *   the popup is up.
 * - Videos get the film icon, not a <video> per row.
 */
import { useEffect, useRef, type ReactElement } from 'react'
import { Film, ImageIcon, X } from 'lucide-react'
import { fileName } from '@/lib/media-gallery'
import { overlayAutoHide, useMediaStore } from '@/store/media-store'
import { useGitStore } from '@/store/git-store'
import { unrootedMediaUrl } from '@/tauri/files'
import { startMediaDrag } from '@/components/Media/start-media-drag'

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const swallow = (e: { preventDefault: () => void }): void => e.preventDefault()

export function MediaOverlay(): ReactElement | null {
  const visible = useMediaStore((s) => s.overlayVisible)
  const items = useMediaStore((s) => s.overlayItems)
  const hovered = useRef(false)

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !hovered.current) return
      // Capture phase on window: runs before xterm's textarea sees the key.
      e.preventDefault()
      e.stopPropagation()
      useMediaStore.getState().dismissOverlay()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible])

  // Unmounting under the pointer fires no mouseleave; reset the pause.
  useEffect(() => {
    if (!visible) hovered.current = false
  }, [visible])

  if (!visible || items.length === 0) return null

  const open = (path: string): void => {
    const media = useMediaStore.getState()
    media.dismissOverlay()
    useGitStore.getState().setMode('media')
    void media.open(path)
  }

  return (
    <div
      data-focus-return
      data-covers-webview
      onMouseEnter={() => {
        hovered.current = true
        overlayAutoHide.pause()
      }}
      onMouseLeave={() => {
        hovered.current = false
        overlayAutoHide.resume()
      }}
      className="fixed bottom-8 right-4 z-50 flex w-72 flex-col rounded-md border border-border bg-card/95 text-xs shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-muted-foreground">
        <span>New media</span>
        <button tabIndex={-1} onMouseDown={swallow} onClick={() => useMediaStore.getState().dismissOverlay()} title="Dismiss (Esc while hovered)" className="rounded p-0.5 hover:bg-muted hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div onScroll={() => overlayAutoHide.touch()} className="flex max-h-72 flex-col gap-1 overflow-y-auto p-1">
        {items.map((item) => (
          <button
            key={item.path}
            tabIndex={-1}
            onMouseDown={swallow}
            // Drag into a pane inserts the path; a release in place opens it.
            onPointerDown={(e) => startMediaDrag(e, item, () => open(item.path))}
            title={`${item.path}\nOpen in the Media panel, or drag into a pane`}
            className="flex items-center gap-2 rounded p-1 text-left hover:bg-muted"
          >
            <div className="flex h-10 w-14 shrink-0 items-center justify-center overflow-hidden bg-muted/40">
              {!item.opened
                ? <ImageIcon className="h-5 w-5 text-muted-foreground" />
                : item.kind === 'video'
                ? <Film className="h-5 w-5 text-muted-foreground" />
                : <img src={unrootedMediaUrl(item.path, item.shownAt)} alt="" draggable={false} className="max-h-full max-w-full object-contain" />}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">{fileName(item.path)}</span>
              <span className="truncate text-muted-foreground">{item.source} · {time(item.shownAt)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

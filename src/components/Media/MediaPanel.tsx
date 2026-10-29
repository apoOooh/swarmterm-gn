import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Film, ImageIcon, PenLine } from 'lucide-react'
import { MediaPathView } from '@/components/Files/MediaView'
import { fileName, itemName, samePath } from '@/lib/media-gallery'
import { AnnotateView } from '@/components/Media/AnnotateView'
import { useMediaStore } from '@/store/media-store'
import { unrootedMediaUrl } from '@/tauri/files'
import { startMediaDrag } from '@/components/Media/start-media-drag'

/** Pixels per wheel "line" (deltaMode 1, e.g. Firefox-style mice); same as media-zoom's wheelPixels. */
const WHEEL_LINE_PX = 16

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Right-panel Media mode: large viewer on top, newest-first thumbnail strip below. */
export function MediaPanel(): ReactElement {
  const items = useMediaStore((s) => s.items)
  const selectedPath = useMediaStore((s) => s.selectedPath)
  const open = useMediaStore((s) => s.open)
  const selected = items.find((i) => selectedPath !== null && samePath(i.path, selectedPath)) ?? items[0]
  // Annotate mode belongs to one item: selecting another one leaves it (marks discarded).
  const [annotating, setAnnotating] = useState<string | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  const selectedKey = selected?.path.toLowerCase()
  const hasItems = selected !== undefined
  // Keep the shown item visible in the strip. Only on a selection change: a
  // new item arriving at the left edge must not yank the strip while the user
  // looks at an older one. Scrolls the strip only (scrollIntoView would also
  // move the panel's ancestors).
  useEffect(() => {
    const el = strip.current
    const item = el?.querySelector<HTMLElement>('[data-active]')
    if (!el || !item) return
    // The strip is `relative`, so it is the items' offsetParent.
    const left = item.offsetLeft
    if (left < el.scrollLeft) el.scrollLeft = left
    else if (left + item.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = left + item.offsetWidth - el.clientWidth
  }, [selectedKey])
  useEffect(() => {
    const el = strip.current
    if (!el) return
    // A plain mouse wheel only scrolls vertically: map it to the strip's axis.
    // Non-passive so the panel behind does not scroll as well.
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaMode === 2 ? e.deltaY * el.clientWidth : e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [hasItems])
  if (!selected) {
    return <div className="flex min-w-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
      <p>Images and videos whose paths appear in a pane, and clipboard images (if enabled), show up here. Nothing here is visible to agents.</p>
    </div>
  }
  const canAnnotate = selected.opened && selected.kind === 'image'
  const annotate = canAnnotate && annotating !== null && samePath(annotating, selected.path)
  // min-w-0: the panel body is a flex row, and without it this column grows to
  // the image's natural width (its min-content), so a large image is centred
  // in a box wider than the clipped panel and shows up off to the right.
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={selected.path}>{itemName(selected)} · {selected.source} · {time(selected.shownAt)}</span>
      {/* Only an opened image: never fetch an unopened item, and videos have no single frame to mark. */}
      {canAnnotate && !annotate && <button tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => setAnnotating(selected.path)}
        title="Annotate: draw on a copy of this image" className="flex shrink-0 items-center gap-1 rounded px-1 hover:bg-muted hover:text-foreground">
        <PenLine className="h-3.5 w-3.5" />Annotate
      </button>}
    </div>
    {annotate
      ? <AnnotateView key={selected.path} item={selected} onClose={() => setAnnotating(null)} />
      : selected.opened
      ? <MediaPathView path={selected.path} kind={selected.kind} revision={selected.shownAt} />
      // Not registered yet: the file is only served after this explicit click.
      : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
        <ImageIcon className="h-8 w-8" />
        <button tabIndex={-1} onClick={() => void open(selected.path)} className="rounded border border-border px-2 py-1 text-foreground hover:bg-muted">Show {fileName(selected.path)}</button>
      </div>}
    {/* Clicks hand focus back to the terminal (data-focus-return), so the
        strip never keeps the keyboard by accident. It is still reachable with
        Tab on purpose: arrow keys scrolling a long strip is the keyboard path
        to items scrolled out of view. Its items stay tabIndex -1. */}
    <div data-focus-return className="flex shrink-0 items-stretch border-t border-border">
      <button tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => scrollStrip(strip.current, -1)} title="Scroll left"
        className="shrink-0 px-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronLeft className="h-4 w-4" /></button>
      <div ref={strip} tabIndex={0} aria-label="Media items"
        onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); scrollStrip(strip.current, e.key === 'ArrowLeft' ? -1 : 1) } }}
        className="media-strip relative flex min-w-0 flex-1 gap-2 overflow-x-scroll p-2 outline-none focus-visible:ring-1 focus-visible:ring-[#a855f7]">
      {items.map((item) => {
        const active = samePath(item.path, selected.path)
        return <button
          key={item.path}
          data-active={active || undefined}
          tabIndex={-1}
          // A press that moves is a drag into a pane (lib/media-drag.ts); a
          // release in place is the click that opens the item. No onClick or
          // key handler: the button is tabIndex -1, so nothing else activates
          // it. mousedown is swallowed so a drag selects no text and parks no
          // focus on the button (the click still bubbles to focus-return).
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => startMediaDrag(e, item, () => void open(item.path))}
          title={`${item.path}\n${item.source} · ${time(item.shownAt)}\nDrag into a pane to insert the path`}
          className={['flex w-24 shrink-0 flex-col gap-0.5 rounded border p-1 text-left text-[10px]', active ? 'border-[#a855f7]' : 'border-border hover:bg-muted'].join(' ')}
        >
          <div className="flex h-14 items-center justify-center overflow-hidden bg-muted/40">
            {!item.opened
              ? <ImageIcon className="h-6 w-6 text-muted-foreground" />
              : item.kind === 'video'
                // An icon, not a <video> per item: up to 50 would each fetch metadata.
                ? <Film className="h-6 w-6 text-muted-foreground" />
                : <img src={unrootedMediaUrl(item.path, item.shownAt)} alt="" loading="lazy" draggable={false} className="max-h-full max-w-full object-contain" />}
          </div>
          <span className="truncate text-foreground">{itemName(item)}</span>
          <span className="truncate text-muted-foreground">{item.source} · {time(item.shownAt)}</span>
        </button>
      })}
      </div>
      <button tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => scrollStrip(strip.current, 1)} title="Scroll right"
        className="shrink-0 px-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronRight className="h-4 w-4" /></button>
    </div>
  </div>
}

/** One arrow press moves most of a visible width, keeping an item of context. */
function scrollStrip(el: HTMLElement | null, dir: -1 | 1): void {
  if (el) el.scrollBy({ left: dir * Math.max(104, el.clientWidth - 104), behavior: 'smooth' })
}

import { useState, type ReactElement } from 'react'
import { Film, ImageIcon, PenLine } from 'lucide-react'
import { MediaPathView } from '@/components/Files/MediaView'
import { fileName, itemName, samePath } from '@/lib/media-gallery'
import { AnnotateView } from '@/components/Media/AnnotateView'
import { useMediaStore } from '@/store/media-store'
import { unrootedMediaUrl } from '@/tauri/files'
import { startMediaDrag } from '@/components/Media/start-media-drag'

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Right-panel Media mode: large viewer on top, newest-first thumbnail strip below. */
export function MediaPanel(): ReactElement {
  const items = useMediaStore((s) => s.items)
  const selectedPath = useMediaStore((s) => s.selectedPath)
  const open = useMediaStore((s) => s.open)
  const selected = items.find((i) => selectedPath !== null && samePath(i.path, selectedPath)) ?? items[0]
  // Annotate mode belongs to one item: selecting another one leaves it (marks discarded).
  const [annotating, setAnnotating] = useState<string | null>(null)
  if (!selected) {
    return <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
      <p>Images and videos whose paths appear in a pane, and clipboard images (if enabled), show up here. Nothing here is visible to agents.</p>
    </div>
  }
  const canAnnotate = selected.opened && selected.kind === 'image'
  const annotate = canAnnotate && annotating !== null && samePath(annotating, selected.path)
  return <div className="flex min-h-0 flex-1 flex-col">
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
    {/* The strip needs no keyboard: hand focus back to the terminal after a click. */}
    <div data-focus-return className="flex shrink-0 gap-2 overflow-x-auto border-t border-border p-2">
      {items.map((item) => {
        const active = samePath(item.path, selected.path)
        return <button
          key={item.path}
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
                // An icon, not a <video> per item: up to 100 would each fetch metadata.
                ? <Film className="h-6 w-6 text-muted-foreground" />
                : <img src={unrootedMediaUrl(item.path, item.shownAt)} alt="" loading="lazy" draggable={false} className="max-h-full max-w-full object-contain" />}
          </div>
          <span className="truncate text-foreground">{itemName(item)}</span>
          <span className="truncate text-muted-foreground">{item.source} · {time(item.shownAt)}</span>
        </button>
      })}
    </div>
  </div>
}

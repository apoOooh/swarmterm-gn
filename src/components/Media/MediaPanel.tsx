import type { ReactElement } from 'react'
import { Film, ImageIcon } from 'lucide-react'
import { MediaPathView } from '@/components/Files/MediaView'
import { fileName, samePath } from '@/lib/media-gallery'
import { useMediaStore } from '@/store/media-store'
import { unrootedMediaUrl } from '@/tauri/files'

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Right-panel Media mode: large viewer on top, newest-first thumbnail strip below. */
export function MediaPanel(): ReactElement {
  const items = useMediaStore((s) => s.items)
  const selectedPath = useMediaStore((s) => s.selectedPath)
  const open = useMediaStore((s) => s.open)
  const selected = items.find((i) => selectedPath !== null && samePath(i.path, selectedPath)) ?? items[0]
  if (!selected) {
    return <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
      <p>Images and videos whose paths appear in a pane, and clipboard images (if enabled), show up here. Nothing here is visible to agents.</p>
    </div>
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 truncate border-b border-border px-2 py-1 text-xs text-muted-foreground" title={selected.path}>
      {fileName(selected.path)} · {selected.source} · {time(selected.shownAt)}
    </div>
    {selected.opened
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
          onClick={() => void open(item.path)}
          title={`${item.path}\n${item.source} · ${time(item.shownAt)}`}
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
          <span className="truncate text-foreground">{fileName(item.path)}</span>
          <span className="truncate text-muted-foreground">{item.source} · {time(item.shownAt)}</span>
        </button>
      })}
    </div>
  </div>
}

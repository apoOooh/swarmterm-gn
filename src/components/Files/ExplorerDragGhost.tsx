import { File, Files, Film, ImageIcon } from 'lucide-react'
import { dragLabel } from '@/lib/pointer-drag'
import { useExplorerDragStore } from '@/store/explorer-drag-store'
import { cn } from '@/lib/utils'

const HINT = { copy: 'Insert / copy', move: 'Move here', none: '' } as const

/** Follows the pointer during an explorer or media drag. pointer-events-none so hit-testing sees what is underneath. */
export function ExplorerDragGhost(): React.ReactElement | null {
  const drag = useExplorerDragStore((s) => s.drag)
  if (!drag) return null
  const ghost = drag.ghost
  const Icon = ghost && 'icon' in ghost ? (ghost.icon === 'film' ? Film : ImageIcon) : drag.paths.length > 1 ? Files : File
  return <div aria-hidden className={cn('pointer-events-none fixed z-[1000] flex max-w-[260px] items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs shadow-lg', drag.effect === 'none' ? 'border-border opacity-70' : 'border-ring')}
    style={{ left: drag.x + 14, top: drag.y + 14 }}>
    {ghost && 'url' in ghost
      ? <img src={ghost.url} alt="" draggable={false} className="h-10 w-14 shrink-0 object-contain" />
      : <Icon size={ghost ? 20 : 13} className="shrink-0 text-muted-foreground" />}
    <span className="truncate">{dragLabel(drag.paths)}</span>
    {HINT[drag.effect] && <span className="shrink-0 text-[10px] text-muted-foreground">· {HINT[drag.effect]}</span>}
  </div>
}

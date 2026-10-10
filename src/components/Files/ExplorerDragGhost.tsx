import { File, Files } from 'lucide-react'
import { dragLabel } from '@/lib/pointer-drag'
import { useExplorerDragStore } from '@/store/explorer-drag-store'
import { cn } from '@/lib/utils'

const HINT = { copy: 'Insert / copy', move: 'Move here', none: '' } as const

/** Follows the pointer during an explorer drag. pointer-events-none so hit-testing sees what is underneath. */
export function ExplorerDragGhost(): React.ReactElement | null {
  const drag = useExplorerDragStore((s) => s.drag)
  if (!drag) return null
  const Icon = drag.paths.length > 1 ? Files : File
  return <div aria-hidden className={cn('pointer-events-none fixed z-[1000] flex max-w-[260px] items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs shadow-lg', drag.effect === 'none' ? 'border-border opacity-70' : 'border-ring')}
    style={{ left: drag.x + 14, top: drag.y + 14 }}>
    <Icon size={13} className="shrink-0 text-muted-foreground" />
    <span className="truncate">{dragLabel(drag.paths)}</span>
    {HINT[drag.effect] && <span className="shrink-0 text-[10px] text-muted-foreground">· {HINT[drag.effect]}</span>}
  </div>
}

import type { ReactElement } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import type { DockSide } from '@/lib/layout-tree'
import { DOCK_DROP_PREFIX, MEMBER_DRAG_PREFIX, dockDropId } from '@/lib/war-room-drop'
import { cn } from '@/lib/utils'

/** Where the dragged pane would land inside the target, per side (CSS insets). */
const LANDING: Record<DockSide, string> = {
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  top: 'inset-x-0 top-0 h-1/2',
  bottom: 'inset-x-0 bottom-0 h-1/2'
}

/**
 * Drag-to-split picker: while another pane is dragged over this one, a plus of
 * tiles appears in the middle — four sides dock the dragged pane beside this
 * one, the centre (no droppable of its own, so it falls through to the pane's
 * reorder droppable) swaps the two as before. Hovering a side shades the half
 * the dragged pane will take.
 *
 * Tiles stay mounted for the whole drag (only hidden while the pointer is
 * elsewhere) so dnd-kit has measured them before the pointer arrives; the
 * collision priority over the pane underneath is lib/layout-collision.ts.
 */
export function DockPicker({ leafId }: { leafId: string }): ReactElement | null {
  const { active, over } = useDndContext()
  const activeId = active ? String(active.id) : null
  if (activeId === null || activeId === leafId || activeId.startsWith(MEMBER_DRAG_PREFIX)) return null

  const overId = over ? String(over.id) : null
  const ownPrefix = `${DOCK_DROP_PREFIX}${leafId}:`
  const hovered = overId === leafId || (overId?.startsWith(ownPrefix) ?? false)
  const side = overId?.startsWith(ownPrefix) ? (overId.slice(ownPrefix.length) as DockSide) : null

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-20 transition-opacity duration-100',
        hovered ? 'opacity-100' : 'opacity-0'
      )}
    >
      {side && (
        <div className={cn('absolute rounded-sm border-2 border-primary bg-primary/20', LANDING[side])} />
      )}
      <div className="absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 grid-cols-3 grid-rows-3 gap-1 rounded-md border border-border bg-card/90 p-1.5 shadow-xl">
        <span />
        <DockTile leafId={leafId} side="top" />
        <span />
        <DockTile leafId={leafId} side="left" />
        <div
          title="Swap panes"
          className={cn(
            'flex h-9 w-12 items-center justify-center rounded-sm border text-[10px] text-muted-foreground',
            overId === leafId ? 'border-primary bg-primary/20 text-foreground' : 'border-border'
          )}
        >
          Swap
        </div>
        <DockTile leafId={leafId} side="right" />
        <span />
        <DockTile leafId={leafId} side="bottom" />
        <span />
      </div>
    </div>
  )
}

/** Mini pane outline with the side the dragged pane will take filled in. */
function DockTile({ leafId, side }: { leafId: string; side: DockSide }): ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id: dockDropId(leafId, side) })
  return (
    <div
      ref={setNodeRef}
      title={`Split: dragged pane ${side}`}
      className={cn(
        'pointer-events-auto relative h-9 w-12 overflow-hidden rounded-sm border',
        isOver ? 'border-primary' : 'border-border'
      )}
    >
      <div className={cn('absolute', LANDING[side], isOver ? 'bg-primary' : 'bg-muted-foreground/40')} />
    </div>
  )
}

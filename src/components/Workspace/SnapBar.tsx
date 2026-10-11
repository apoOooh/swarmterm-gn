import type { ReactElement } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { collectLeaves, findLeaf, type LayoutNode } from '@/lib/layout-tree'
import { applyPreset, presetsFor, slotRects, type LayoutPreset, type SlotRect } from '@/lib/layout-presets'
import { MEMBER_DRAG_PREFIX, SNAP_DROP_PREFIX, snapDropId } from '@/lib/war-room-drop'
import { cn } from '@/lib/utils'

interface SnapBarProps {
  /** The workspace's stored layout (drawered leaves included). */
  layout: LayoutNode
  drawerLeafIds: readonly string[]
}

const pct = (r: SlotRect) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`
})

/**
 * Snap layouts (the Windows 11 snap bar): while a pane of this workspace is
 * dragged, a strip of layout previews sits at the top centre. Each preview's
 * slots are drop targets; dropping rebuilds the whole workspace as that preset
 * with the dragged pane in the chosen slot. Hovering a slot also outlines the
 * resulting layout over the workspace itself, computed by the same
 * `applyPreset` the store will run — what you see is what you get.
 */
export function SnapBar({ layout, drawerLeafIds }: SnapBarProps): ReactElement | null {
  const { active, over } = useDndContext()
  const activeId = active ? String(active.id) : null
  // Only panes of THIS workspace (the inactive ones are display:none anyway,
  // but their droppables would still register).
  if (activeId === null || activeId.startsWith(MEMBER_DRAG_PREFIX) || !findLeaf(layout, activeId)) return null
  if (drawerLeafIds.includes(activeId)) return null

  const hidden = new Set(drawerLeafIds)
  const visible = collectLeaves(layout).filter((l) => !hidden.has(l.id))
  const presets = presetsFor(visible.length)
  if (presets.length === 0) return null

  const overId = over ? String(over.id) : null
  let preview: { rects: SlotRect[]; draggedSlot: number } | null = null
  if (overId?.startsWith(SNAP_DROP_PREFIX)) {
    const [presetId, rawSlot] = overId.slice(SNAP_DROP_PREFIX.length).split(':')
    const slot = Number(rawSlot)
    // Throwaway split ids: the preview tree is only measured, never stored.
    const tree = applyPreset(layout, drawerLeafIds, presetId, activeId, slot, () => 'preview')
    if (tree) {
      // Measure only the arranged block — drawered leaves are not on screen.
      const arranged = presets.find((p) => p.id === presetId)!
      const order = collectLeaves(tree).filter((l) => !hidden.has(l.id))
      preview = { rects: slotRects(arranged.build(order, () => 'preview')), draggedSlot: slot }
    }
  }

  return (
    <>
      {preview && (
        <div className="pointer-events-none absolute inset-2 z-30">
          {preview.rects.map((r, i) => (
            <div
              key={i}
              style={pct(r)}
              className={cn(
                'absolute rounded-md border-2',
                i === preview!.draggedSlot ? 'border-primary bg-primary/25' : 'border-primary/50 bg-background/40'
              )}
            />
          ))}
        </div>
      )}
      {/* Centring and the entrance animation live on separate elements: the
          animate-in keyframes own `transform`, so on one element they would
          cancel -translate-x-1/2 mid-animation — exactly when dnd-kit measures
          the freshly mounted slots, leaving their hit rects off-centre. */}
      <div className="absolute left-1/2 top-3 z-40 -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card/95 px-2.5 py-2 shadow-2xl animate-in fade-in">
          {presets.map((p) => (
            <PresetThumb key={p.id} preset={p} count={visible.length} />
          ))}
        </div>
      </div>
    </>
  )
}

/** One preset preview: its slot rectangles, each a droppable. */
function PresetThumb({ preset, count }: { preset: LayoutPreset; count: number }): ReactElement {
  // Placeholder leaves: only the shape matters for the thumbnail.
  const shape = preset.build(
    Array.from({ length: count }, (_, i) => ({ type: 'leaf' as const, id: String(i), terminalId: String(i) })),
    () => 'thumb'
  )
  return (
    <div title={preset.label} className="relative h-11 w-[72px] rounded-sm border border-border bg-background">
      {slotRects(shape).map((r, i) => (
        <SnapSlot key={i} presetId={preset.id} slot={i} rect={r} />
      ))}
    </div>
  )
}

function SnapSlot({ presetId, slot, rect }: { presetId: string; slot: number; rect: SlotRect }): ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id: snapDropId(presetId, slot) })
  return (
    <div ref={setNodeRef} style={pct(rect)} className="absolute p-[1.5px]">
      <div
        className={cn(
          'h-full w-full rounded-[2px] transition-colors',
          isOver ? 'bg-primary' : 'bg-muted-foreground/35 hover:bg-muted-foreground/50'
        )}
      />
    </div>
  )
}

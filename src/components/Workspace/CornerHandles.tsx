import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import type { GroupImperativeHandle } from 'react-resizable-panels'
import type { LayoutNode, SplitNode } from '@/lib/layout-tree'
import { junctionsFor, sizesForPointer, splitRects, type Junction, type Rect } from '@/lib/split-junctions'
import { useAppStore } from '@/store/app-store'

interface CornerHandlesProps {
  layout: LayoutNode
  /** Live Group handles keyed by split id, registered by Workspace.renderNode. */
  groups: RefObject<Map<string, GroupImperativeHandle>>
  /** Inset of the tree inside the overlay's parent (Workspace's `p-2`). */
  inset: number
}

interface Drag {
  pointerId: number
  junction: Junction
  hRect: Rect
  vRect: Rect
  hSizes: [number, number]
  vSizes: [number, number]
}

/**
 * Grab handles where two perpendicular separators meet: one drag resizes both
 * splits. The Groups are uncontrolled (`defaultLayout`), so a drag drives them
 * through their imperative `setLayout` for live feedback and commits to the
 * store once on release — writing the store per move would not move a mounted
 * Group anyway and would churn saved-workspace sync.
 */
export function CornerHandles({ layout, groups, inset }: CornerHandlesProps): ReactElement | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const resizeSplitNode = useAppStore((s) => s.resizeSplitNode)
  const equalizeSplitNode = useAppStore((s) => s.equalizeSplitNode)

  useEffect(() => {
    const parent = rootRef.current?.parentElement
    if (!parent) return
    const measure = (): void => setSize({ w: parent.clientWidth, h: parent.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  const rect: Rect | null = size
    ? { x: inset, y: inset, w: size.w - 2 * inset, h: size.h - 2 * inset }
    : null
  const junctions = rect ? junctionsFor(layout, rect) : []

  function apply(splitId: string, sizes: [number, number]): void {
    groups.current?.get(splitId)?.setLayout({ [`${splitId}:a`]: sizes[0], [`${splitId}:b`]: sizes[1] })
  }

  function onPointerDown(e: React.PointerEvent, j: Junction): void {
    if (!rect || e.button !== 0) return
    const rects = splitRects(layout, rect)
    const h = findSplit(layout, j.hSplitId)
    const v = findSplit(layout, j.vSplitId)
    if (!h || !v) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({
      pointerId: e.pointerId,
      junction: j,
      hRect: rects.get(h.id)!,
      vRect: rects.get(v.id)!,
      hSizes: h.sizes,
      vSizes: v.sizes
    })
  }

  function onPointerMove(e: React.PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return
    const box = rootRef.current!.getBoundingClientRect()
    const p = { x: e.clientX - box.left, y: e.clientY - box.top }
    const hSizes = sizesForPointer('horizontal', drag.hRect, p)
    const vSizes = sizesForPointer('vertical', drag.vRect, p)
    apply(drag.junction.hSplitId, hSizes)
    apply(drag.junction.vSplitId, vSizes)
    setDrag({ ...drag, hSizes, vSizes })
  }

  function onPointerUp(e: React.PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return
    resizeSplitNode(drag.junction.hSplitId, drag.hSizes)
    resizeSplitNode(drag.junction.vSplitId, drag.vSizes)
    setDrag(null)
  }

  return (
    // pointer-events stay off the full-size overlay so panes underneath keep
    // their clicks; only the handles themselves catch the pointer.
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-10">
      {junctions.map((j) => {
        const active = drag?.junction.hSplitId === j.hSplitId && drag.junction.vSplitId === j.vSplitId
        return (
          <div
            key={`${j.hSplitId}/${j.vSplitId}`}
            data-corner-handle
            title="Drag to resize both directions, double-click to even out"
            onPointerDown={(e) => onPointerDown(e, j)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => {
              equalizeSplitNode(j.hSplitId)
              equalizeSplitNode(j.vSplitId)
            }}
            className={
              'pointer-events-auto absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-sm transition-colors hover:bg-ring' +
              (active ? ' bg-ring' : '')
            }
            style={{ left: j.x, top: j.y }}
          />
        )
      })}
    </div>
  )
}

function findSplit(tree: LayoutNode, id: string): SplitNode | null {
  if (tree.type === 'leaf') return null
  if (tree.id === id) return tree
  return findSplit(tree.children[0], id) ?? findSplit(tree.children[1], id)
}

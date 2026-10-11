/**
 * Corner resizing for the split-tree layout: where a horizontal and a vertical
 * separator meet, one drag moves both. Pure geometry over the tree's `sizes`,
 * so the overlay can be placed and driven without measuring the DOM per split.
 */

import type { Direction, LayoutNode, SplitNode } from '@/lib/layout-tree'

/** Thickness of a split separator in px — must match `w-2`/`h-2` in Workspace.tsx. */
export const SEPARATOR_PX = 8
/** Smallest pane share in percent — must match the Panels' `minSize`. */
export const MIN_PANE_PCT = 8

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A point where two perpendicular separators meet. */
export interface Junction {
  x: number
  y: number
  /** Split whose separator is a vertical line (children side by side). */
  hSplitId: string
  /** Split whose separator is a horizontal line (children stacked). */
  vSplitId: string
}

/** Pixel rect of every node, laid out like react-resizable-panels does. */
export function splitRects(tree: LayoutNode, rect: Rect): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const walk = (node: LayoutNode, r: Rect): void => {
    out.set(node.id, r)
    if (node.type === 'leaf') return
    const [a, b] = childRects(node, r)
    walk(node.children[0], a)
    walk(node.children[1], b)
  }
  walk(tree, rect)
  return out
}

function childRects(node: SplitNode, r: Rect): [Rect, Rect] {
  if (node.direction === 'horizontal') {
    const wa = ((r.w - SEPARATOR_PX) * node.sizes[0]) / 100
    return [
      { x: r.x, y: r.y, w: wa, h: r.h },
      { x: r.x + wa + SEPARATOR_PX, y: r.y, w: r.w - wa - SEPARATOR_PX, h: r.h }
    ]
  }
  const ha = ((r.h - SEPARATOR_PX) * node.sizes[0]) / 100
  return [
    { x: r.x, y: r.y, w: r.w, h: ha },
    { x: r.x, y: r.y + ha + SEPARATOR_PX, w: r.w, h: r.h - ha - SEPARATOR_PX }
  ]
}

/** Centre line of a split's separator along its own axis. */
function separatorCentre(node: SplitNode, r: Rect): number {
  const [a] = childRects(node, r)
  return node.direction === 'horizontal'
    ? a.x + a.w + SEPARATOR_PX / 2
    : a.y + a.h + SEPARATOR_PX / 2
}

function descendantSplits(node: LayoutNode): SplitNode[] {
  if (node.type === 'leaf') return []
  return [node, ...descendantSplits(node.children[0]), ...descendantSplits(node.children[1])]
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5

/**
 * Every T- or cross-junction in the tree: a split paired with a perpendicular
 * descendant whose rect borders the split's separator. Only descendants can
 * meet a separator — anything outside the split's rect lies beyond its ends.
 */
export function junctionsFor(tree: LayoutNode, rect: Rect): Junction[] {
  const rects = splitRects(tree, rect)
  const out: Junction[] = []
  for (const parent of descendantSplits(tree)) {
    const pr = rects.get(parent.id)!
    const line = separatorCentre(parent, pr)
    const horizontal = parent.direction === 'horizontal'
    for (const side of [0, 1] as const) {
      for (const d of descendantSplits(parent.children[side])) {
        if (d.direction === parent.direction) continue
        const dr = rects.get(d.id)!
        // The descendant's edge facing the separator must sit on its band.
        const edge = horizontal
          ? (side === 0 ? dr.x + dr.w : dr.x)
          : (side === 0 ? dr.y + dr.h : dr.y)
        const want = line + (side === 0 ? -1 : 1) * (SEPARATOR_PX / 2)
        if (!near(edge, want)) continue
        const cross = separatorCentre(d, dr)
        out.push(horizontal
          ? { x: line, y: cross, hSplitId: parent.id, vSplitId: d.id }
          : { x: cross, y: line, hSplitId: d.id, vSplitId: parent.id })
      }
    }
  }
  return out
}

/** New `sizes` for a split of `direction` in `rect` so its separator sits under `pointer`. */
export function sizesForPointer(
  direction: Direction,
  rect: Rect,
  pointer: { x: number; y: number }
): [number, number] {
  const span = (direction === 'horizontal' ? rect.w : rect.h) - SEPARATOR_PX
  const offset = direction === 'horizontal' ? pointer.x - rect.x : pointer.y - rect.y
  const raw = span > 0 ? ((offset - SEPARATOR_PX / 2) / span) * 100 : 50
  const a = Math.min(100 - MIN_PANE_PCT, Math.max(MIN_PANE_PCT, raw))
  return [a, 100 - a]
}

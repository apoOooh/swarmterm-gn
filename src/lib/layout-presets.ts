/**
 * Snap layouts: whole-workspace arrangements offered while a pane is dragged
 * (the Windows 11 snap-bar idea). A preset rebuilds the visible panes into a
 * fresh tree; the dragged pane goes into the slot the user dropped it on and
 * the rest fill the remaining slots in their current depth-first order.
 *
 * Pure — the snap bar draws its previews from `slotRects` of the very tree
 * `applyPreset` would produce, so what the user sees is what they get.
 */

import {
  buildBalancedTree,
  collectLeaves,
  paneLayoutFor,
  type LayoutNode,
  type LeafNode
} from '@/lib/layout-tree'

export interface LayoutPreset {
  id: string
  label: string
  /** Build a tree whose depth-first leaf order is exactly `leaves`. */
  build: (leaves: LeafNode[], makeSplitId: () => string) => LayoutNode
}

const COLUMNS: LayoutPreset = {
  id: 'columns',
  label: 'Side by side',
  build: (leaves, mk) => buildBalancedTree(leaves, 'horizontal', mk)
}

const ROWS: LayoutPreset = {
  id: 'rows',
  label: 'Stacked',
  build: (leaves, mk) => buildBalancedTree(leaves, 'vertical', mk)
}

const GRID: LayoutPreset = {
  id: 'grid',
  label: 'Grid',
  // paneLayoutFor calls makeLeaf exactly `count` times, row-major, so feeding
  // it the leaves in order keeps slot order equal to input order.
  build: (leaves, mk) => {
    let i = 0
    return paneLayoutFor(leaves.length, () => leaves[i++], mk)
  }
}

const MAIN_LEFT: LayoutPreset = {
  id: 'main-left',
  label: 'Main left',
  build: (leaves, mk) => ({
    type: 'split',
    id: mk(),
    direction: 'horizontal',
    sizes: [50, 50],
    children: [leaves[0], buildBalancedTree(leaves.slice(1), 'vertical', mk)]
  })
}

const MAIN_TOP: LayoutPreset = {
  id: 'main-top',
  label: 'Main top',
  build: (leaves, mk) => ({
    type: 'split',
    id: mk(),
    direction: 'vertical',
    sizes: [50, 50],
    children: [leaves[0], buildBalancedTree(leaves.slice(1), 'horizontal', mk)]
  })
}

/**
 * Presets that make sense for `count` visible panes. Two panes only have two
 * distinct shapes (grid and main-pane would duplicate them); one pane has
 * nothing to arrange.
 */
export function presetsFor(count: number): LayoutPreset[] {
  if (count < 2) return []
  if (count === 2) return [COLUMNS, ROWS]
  return [COLUMNS, ROWS, GRID, MAIN_LEFT, MAIN_TOP]
}

/** A slot's rectangle in unit coordinates (0..1) of the workspace. */
export interface SlotRect {
  x: number
  y: number
  w: number
  h: number
}

/** Each leaf slot's rectangle, in depth-first order (the order presets fill). */
export function slotRects(tree: LayoutNode): SlotRect[] {
  const out: SlotRect[] = []
  const walk = (node: LayoutNode, r: SlotRect): void => {
    if (node.type === 'leaf') {
      out.push(r)
      return
    }
    const f = node.sizes[0] / (node.sizes[0] + node.sizes[1])
    if (node.direction === 'horizontal') {
      walk(node.children[0], { x: r.x, y: r.y, w: r.w * f, h: r.h })
      walk(node.children[1], { x: r.x + r.w * f, y: r.y, w: r.w * (1 - f), h: r.h })
    } else {
      walk(node.children[0], { x: r.x, y: r.y, w: r.w, h: r.h * f })
      walk(node.children[1], { x: r.x, y: r.y + r.h * f, w: r.w, h: r.h * (1 - f) })
    }
  }
  walk(tree, { x: 0, y: 0, w: 1, h: 1 })
  return out
}

/**
 * Rebuild `layout` as preset `presetId` with `draggedLeafId` in slot `slot`.
 * Only visible panes are arranged. Drawered leaves must stay in the tree (their
 * pty/xterm live on — see lib/pane-drawer.ts), but their original slot cannot
 * survive a full rebuild, so they are appended after the arranged block and a
 * restore brings them back at the end. Returns null when the request does not
 * fit the current panes (unknown preset/leaf, drawered leaf, slot out of range,
 * preset not offered for this count); never mutates its input.
 */
export function applyPreset(
  layout: LayoutNode,
  drawerLeafIds: readonly string[],
  presetId: string,
  draggedLeafId: string,
  slot: number,
  makeSplitId: () => string
): LayoutNode | null {
  const hidden = new Set(drawerLeafIds)
  const all = collectLeaves(layout)
  const visible = all.filter((l) => !hidden.has(l.id))
  const preset = presetsFor(visible.length).find((p) => p.id === presetId)
  const dragged = visible.find((l) => l.id === draggedLeafId)
  if (!preset || !dragged || !Number.isInteger(slot) || slot < 0 || slot >= visible.length) return null
  const ordered = visible.filter((l) => l !== dragged)
  ordered.splice(slot, 0, dragged)
  const arranged = preset.build(ordered, makeSplitId)
  const drawered = all.filter((l) => hidden.has(l.id))
  return drawered.length === 0
    ? arranged
    : buildBalancedTree([arranged, ...drawered], 'horizontal', makeSplitId)
}

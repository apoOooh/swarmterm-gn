import { collectLeaves, findLeaf, type LayoutNode, type LeafNode } from '@/lib/layout-tree'

/**
 * The leaf a zoomed workspace shows alone, or null to render the whole tree.
 * A zoom pointing at a leaf that no longer exists (closed, collapsed) simply
 * lapses, so no action has to remember to clear it.
 */
export function zoomedLeaf(layout: LayoutNode, zoomedLeafId: string | undefined): LeafNode | null {
  return zoomedLeafId ? findLeaf(layout, zoomedLeafId) : null
}

/** Next zoom after a toggle on `leafId`: zoom in, or out when it is already zoomed. */
export function toggledZoom(current: string | undefined, leafId: string): string | undefined {
  return current === leafId ? undefined : leafId
}

/**
 * How many panes a zoom hides: every leaf except the zoomed one and the
 * drawered ones (already out of view). Floating panes count — the zoom hides
 * them too. 0 when the zoom has lapsed.
 */
export function zoomHiddenCount(layout: LayoutNode, zoomedLeafId: string | undefined, drawerLeafIds: readonly string[]): number {
  const zoomed = zoomedLeaf(layout, zoomedLeafId)
  if (!zoomed || drawerLeafIds.includes(zoomed.id)) return 0
  return collectLeaves(layout).filter((l) => l.id !== zoomed.id && !drawerLeafIds.includes(l.id)).length
}

import { findLeaf, type LayoutNode, type LeafNode } from '@/lib/layout-tree'

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

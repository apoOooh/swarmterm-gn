import { closeLeaf, collectLeaves, type LayoutNode } from '@/lib/layout-tree'

/**
 * Pane drawer: a drawered pane stays in the stored layout tree and is only
 * pruned at render time. Keeping the leaf in the tree is the whole trick —
 * every lifecycle sweep (App.tsx disposes terminals, titles, previews, War
 * Room seats whose leaf left the layout) still sees it as alive, so its
 * xterm + pty live on in terminal-registry exactly like a pane hidden by zoom,
 * and a restore lands back in its original slot with its original split sizes.
 */

/** The layout to render: the stored tree minus drawered leaves; null when every pane is drawered. */
export function visibleLayout(layout: LayoutNode, drawerLeafIds: readonly string[]): LayoutNode | null {
  let tree: LayoutNode | null = layout
  for (const id of drawerLeafIds) {
    if (tree === null) break
    tree = closeLeaf(tree, id)
  }
  return tree
}

/** Drawer ids that still point at a leaf of `layout` (close/collapse sweep). */
export function drawerAfterRemoval(drawerLeafIds: readonly string[], layout: LayoutNode): string[] {
  const ids = new Set(collectLeaves(layout).map((l) => l.id))
  return drawerLeafIds.filter((id) => ids.has(id))
}

/**
 * The visible leaf that should take focus when `fromLeafId` disappears into
 * the drawer: the next visible one in layout order, wrapping to the start.
 * Undefined when nothing is left on screen.
 */
export function nextVisibleLeafId(
  layout: LayoutNode,
  drawerLeafIds: readonly string[],
  fromLeafId: string
): string | undefined {
  const hidden = new Set(drawerLeafIds)
  const leaves = collectLeaves(layout)
  const start = Math.max(0, leaves.findIndex((l) => l.id === fromLeafId))
  for (let i = 1; i <= leaves.length; i++) {
    const leaf = leaves[(start + i) % leaves.length]
    if (!hidden.has(leaf.id)) return leaf.id
  }
  return undefined
}

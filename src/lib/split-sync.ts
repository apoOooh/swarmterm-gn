import type { LayoutNode } from '@/lib/layout-tree'

/**
 * The split Groups in Workspace.tsx are uncontrolled: `sizes` only seeds a
 * Group when it mounts, and later drags flow store-ward, never back. A store
 * action that rewrites sizes of splits that stay mounted (Tidy) would therefore
 * change the model but not the screen. This picks the splits whose live Group
 * disagrees with the stored sizes, so the caller can push them in through the
 * Group's imperative `setLayout`.
 *
 * `live` reads a mounted Group's current `[first, second]` percentages and
 * returns undefined for a split that has no Group right now (collapsed by the
 * drawer, hidden by zoom, or not measured yet) — those pick up the stored sizes
 * as `defaultLayout` whenever they do mount, so they are skipped here.
 */
export function splitsToRealign(
  tree: LayoutNode,
  live: (splitId: string) => readonly [number, number] | undefined,
  tolerance = 0.5
): Array<{ id: string; sizes: [number, number] }> {
  if (tree.type === 'leaf') return []
  const out: Array<{ id: string; sizes: [number, number] }> = []
  const current = live(tree.id)
  if (current && (Math.abs(current[0] - tree.sizes[0]) > tolerance || Math.abs(current[1] - tree.sizes[1]) > tolerance)) {
    out.push({ id: tree.id, sizes: [tree.sizes[0], tree.sizes[1]] })
  }
  return [...out, ...splitsToRealign(tree.children[0], live, tolerance), ...splitsToRealign(tree.children[1], live, tolerance)]
}

import { collectLeaves, type LayoutNode } from '@/lib/layout-tree'

/**
 * Floating panes: like the drawer (lib/pane-drawer.ts), a floating leaf stays
 * in the stored layout tree and is only pruned from the split view at render
 * time. Every lifecycle sweep still sees it as alive, its pty keeps running,
 * "Dock" drops it back into its original slot, and saved workspaces (which
 * serialize the tree only) restore it docked — no new persisted shape.
 *
 * Rects are fractions of the app content area (below the title bar, across
 * both sidebars), so a window resize keeps them proportionally in place while
 * toggling a sidebar leaves them untouched.
 */
export interface FloatRect {
  leafId: string
  x: number
  y: number
  w: number
  h: number
}

/** DOM id of the app-wide layer (App.tsx) that floating panes portal into. */
export const FLOATING_LAYER_ID = 'floating-layer'

/** Smallest float width/height as a fraction of the content area. */
export const MIN_FLOAT_SIZE = 0.15
const DEFAULT_SIZE = { w: 0.45, h: 0.5 }
const CASCADE = 0.04

export function isFloating(floating: readonly FloatRect[] | undefined, leafId: string): boolean {
  return floating?.some((r) => r.leafId === leafId) ?? false
}

/** Float `leafId` in a new rect, cascaded below the ones already floating. */
export function floatPane(floating: readonly FloatRect[], leafId: string): FloatRect[] {
  if (isFloating(floating, leafId)) return floating as FloatRect[]
  const step = (floating.length % 8) * CASCADE
  return [...floating, clampFloatRect({ leafId, x: 0.2 + step, y: 0.15 + step, ...DEFAULT_SIZE })]
}

export function unfloatPane(floating: readonly FloatRect[], leafId: string): FloatRect[] {
  return floating.filter((r) => r.leafId !== leafId)
}

/** Size first, then position, so a rect never leaves the workspace. */
export function clampFloatRect(r: FloatRect): FloatRect {
  const w = Math.min(1, Math.max(MIN_FLOAT_SIZE, r.w))
  const h = Math.min(1, Math.max(MIN_FLOAT_SIZE, r.h))
  return {
    leafId: r.leafId,
    x: Math.min(1 - w, Math.max(0, r.x)),
    y: Math.min(1 - h, Math.max(0, r.y)),
    w,
    h
  }
}

/** Floating rects that still point at a leaf of `layout` (close/collapse sweep). */
export function floatingAfterRemoval(floating: readonly FloatRect[], layout: LayoutNode): FloatRect[] {
  const ids = new Set(collectLeaves(layout).map((l) => l.id))
  return floating.filter((r) => ids.has(r.leafId))
}

/** Every leaf the split view must not render: drawered plus floating. */
export function hiddenLeafIds(drawerLeafIds: readonly string[], floating: readonly FloatRect[]): string[] {
  return [...drawerLeafIds, ...floating.map((r) => r.leafId)]
}

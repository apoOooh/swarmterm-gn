import { DOCK_DROP_PREFIX, SNAP_DROP_PREFIX } from '@/lib/war-room-drop'

/**
 * Dock tiles and snap slots sit ON TOP of pane droppables, so `pointerWithin`
 * reports both. Its own ordering (corner distance) is not a z-order: a big pane
 * whose corner happens to be nearer would win over the small tile under the
 * pointer and the drop would reorder instead of split. Whenever a layout target
 * is hit, it alone wins. Generic over the collision shape so it stays free of
 * dnd-kit types and testable.
 */
export function preferLayoutTargets<T extends { id: string | number }>(collisions: T[]): T[] {
  const layout = collisions.find((c) => {
    const id = String(c.id)
    return id.startsWith(DOCK_DROP_PREFIX) || id.startsWith(SNAP_DROP_PREFIX)
  })
  return layout ? [layout] : collisions
}

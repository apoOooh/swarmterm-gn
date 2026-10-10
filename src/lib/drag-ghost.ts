/**
 * Pane drag ghost placement. dnd-kit moves the overlay with the grabbed node's
 * top-left, so the ghost card would trail up-left of the pointer — right on
 * top of the snap bar and dock tiles the user is aiming at. Shift it so its
 * top-left sits just below-right of the pointer, like an OS drag image.
 * Structural types keep this free of dnd-kit/DOM imports (and testable).
 */

export const GHOST_CURSOR_OFFSET = 14

interface Transform {
  x: number
  y: number
  scaleX: number
  scaleY: number
}

export function ghostBesideCursor<T extends Transform>(
  transform: T,
  activator: { clientX: number; clientY: number } | null,
  nodeRect: { left: number; top: number } | null
): T {
  if (!activator || !nodeRect) return transform
  return {
    ...transform,
    x: transform.x + activator.clientX - nodeRect.left + GHOST_CURSOR_OFFSET,
    y: transform.y + activator.clientY - nodeRect.top + GHOST_CURSOR_OFFSET
  }
}

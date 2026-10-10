/**
 * Rules for the Files-explorer drag. It runs on pointer events instead of
 * HTML5 drag-and-drop: on Windows Tauri's native drop handler swallows every
 * in-window HTML5 drag, so no drop event arrives and the OS shows a "no-drop"
 * cursor. With pointer events the app owns the gesture, the cursor and the
 * ghost, and the OS drag loop (OLE DoDragDrop) is never entered.
 */
export const DRAG_THRESHOLD_PX = 5

export type DragTargetKind = 'pane' | 'dir' | 'none'
export type DragEffect = 'copy' | 'move' | 'none'

/** A press becomes a drag only after the pointer travels a few pixels — a click stays a click. */
export function pastThreshold(from: { x: number; y: number }, to: { x: number; y: number }, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= threshold
}

/** Terminals receive the path (a copy of nothing); folders move, or copy with Ctrl/Cmd held. */
export function dragEffect(target: DragTargetKind, copyKey: boolean): DragEffect {
  if (target === 'pane') return 'copy'
  if (target === 'dir') return copyKey ? 'copy' : 'move'
  return 'none'
}

/** CSS cursor shown for an effect while dragging. */
export function dragCursor(effect: DragEffect): string {
  return effect === 'copy' ? 'copy' : effect === 'move' ? 'move' : 'no-drop'
}

/** Ghost label: the single name, or the first name plus how many more. */
export function dragLabel(paths: string[]): string {
  const name = (p: string): string => p.split(/[/\\]/).filter(Boolean).at(-1) ?? p
  if (paths.length === 0) return ''
  return paths.length === 1 ? name(paths[0]) : `${name(paths[0])} +${paths.length - 1}`
}

/** Folder a drop on an explorer row lands in: the row itself for folders, else its parent. */
export function dropDirectory(row: { path: string; isDir: boolean; parent: string }): string {
  return row.isDir ? row.path : row.parent
}

/** A folder can never be moved into itself or below itself. */
export function canDropInto(directory: string, paths: string[]): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const dir = norm(directory)
  return paths.every((p) => { const src = norm(p); return dir !== src && !dir.startsWith(`${src}/`) })
}

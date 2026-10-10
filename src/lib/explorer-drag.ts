/**
 * Hand-off for a Files-explorer drag onto a terminal. On Windows Tauri's native
 * drag-drop handler sees the in-window drag too, so the pane's HTML5 `drop` may
 * never fire and the native drop arrives with no paths. Whichever of the two
 * events lands first takes the paths; the other then finds nothing, so a path
 * is never typed twice.
 */
let pending: string[] | null = null
let deadline = Infinity
// The native drop crosses IPC and can arrive after the DOM's `dragend`.
const GRACE_MS = 1500

export function startExplorerDrag(paths: string[]): void {
  pending = paths.length > 0 ? [...paths] : null
  deadline = Infinity
}

/** Paths of the drag in flight, at most once; `null` when there is none. */
export function takeExplorerDrag(now: number = Date.now()): string[] | null {
  const paths = now <= deadline ? pending : null
  pending = null
  return paths
}

/** The drag ended (dropped or cancelled); a late native drop may still claim it briefly. */
export function endExplorerDrag(now: number = Date.now()): void {
  deadline = now + GRACE_MS
}

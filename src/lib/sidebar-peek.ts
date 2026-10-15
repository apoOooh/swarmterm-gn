/** localStorage key the "peek sidebar on left edge" setting is persisted under. */
export const SIDEBAR_PEEK_STORAGE_KEY = 'swarmterm.sidebarPeek'

/** On by default: a hidden sidebar slides in over the workspace from the left edge. */
export const DEFAULT_SIDEBAR_PEEK = true

/** Pointer must rest on the edge this long before the sidebar slides in. */
export const PEEK_OPEN_DELAY_MS = 150

/** Grace period after the pointer leaves the peeking sidebar before it slides out. */
export const PEEK_CLOSE_DELAY_MS = 300

/** What the state the pointer left behind says about a pending close. */
export interface PeekCloseState {
  /** The pointer is back over the sidebar. */
  hovered: boolean
  /** A menu / dialog / listbox is open (Radix portals them outside the sidebar). */
  overlayOpen: boolean
}

/** When the close delay runs out: slide out, or check again after another delay. */
export function peekCloseDecision(state: PeekCloseState): 'close' | 'defer' {
  return state.hovered || state.overlayOpen ? 'defer' : 'close'
}

/** Minimal storage surface — lets tests pass a fake in place of localStorage. */
export interface SidebarPeekStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** Read the persisted setting, defaulting for missing or invalid values. */
export function readStoredSidebarPeek(storage: SidebarPeekStorage): boolean {
  const raw = storage.getItem(SIDEBAR_PEEK_STORAGE_KEY)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return DEFAULT_SIDEBAR_PEEK
}

/** Persist the setting as the literal string "true" / "false". */
export function storeSidebarPeek(storage: SidebarPeekStorage, enabled: boolean): void {
  storage.setItem(SIDEBAR_PEEK_STORAGE_KEY, enabled ? 'true' : 'false')
}

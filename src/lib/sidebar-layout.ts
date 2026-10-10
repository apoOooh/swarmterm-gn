/**
 * How the left rail splits its height. `auto`: Workspaces and Terminals take
 * their content height (capped, then scroll) and Files fills the rest, so new
 * rows push the explorer down. `manual`: the three resizable sections.
 */
export type SidebarLayout = 'auto' | 'manual'

export const SIDEBAR_LAYOUT_STORAGE_KEY = 'swarmterm-sidebar-layout'
export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = 'auto'

export interface SidebarLayoutStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function readSidebarLayout(storage: SidebarLayoutStorage): SidebarLayout {
  const raw = storage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY)
  return raw === 'auto' || raw === 'manual' ? raw : DEFAULT_SIDEBAR_LAYOUT
}

export function storeSidebarLayout(storage: SidebarLayoutStorage, layout: SidebarLayout): void {
  storage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, layout)
}

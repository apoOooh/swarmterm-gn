import { create } from 'zustand'
import {
  DEFAULT_HEADER_LAYOUT,
  moveHeaderItem,
  normalizeHeaderLayout,
  readStoredHeaderLayout,
  storeHeaderLayout,
  setHeaderItemVisibility,
  type HeaderItemId,
  type HeaderItemVisibility,
  type HeaderLayoutPref
} from '@/lib/header-layout-pref'

export interface HeaderLayoutStore extends HeaderLayoutPref {
  move: (id: HeaderItemId, targetId: HeaderItemId) => void
  setVisibility: (id: HeaderItemId, visibility: HeaderItemVisibility) => void
  reset: () => void
}

/**
 * Pane-header item order + core set (Settings → Title bar). Every header
 * subscribes, so a change applies to all panes live. Renderer-only.
 */
export const useHeaderLayoutStore = create<HeaderLayoutStore>((set, get) => {
  const apply = (next: HeaderLayoutPref): void => {
    // Blocked or full storage must not swallow the change itself — it then
    // just doesn't survive a restart.
    try { storeHeaderLayout(window.localStorage, next) } catch (err) { console.warn('[header-layout] not persisted', err) }
    set(next)
  }
  const current = (): HeaderLayoutPref => ({ order: get().order, core: get().core, overflow: get().overflow, off: get().off })
  let initial = normalizeHeaderLayout(DEFAULT_HEADER_LAYOUT)
  try { if (typeof window !== 'undefined') initial = readStoredHeaderLayout(window.localStorage) } catch { /* blocked storage → defaults */ }
  return {
    ...initial,
    move: (id, targetId) => apply(moveHeaderItem(current(), id, targetId)),
    setVisibility: (id, visibility) => apply(setHeaderItemVisibility(current(), id, visibility)),
    reset: () => apply(normalizeHeaderLayout(DEFAULT_HEADER_LAYOUT))
  }
})

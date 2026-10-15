import { create } from 'zustand'
import { DEFAULT_SIDEBAR_PEEK, readStoredSidebarPeek, storeSidebarPeek } from '@/lib/sidebar-peek'

export interface SidebarPeekStore {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

/**
 * Whether a hidden sidebar peeks in as an overlay when the pointer reaches the
 * left edge. Reads the persisted choice on creation and writes every change
 * back to localStorage. Renderer-only — touches `window` directly.
 */
export const useSidebarPeekStore = create<SidebarPeekStore>((set) => ({
  enabled:
    typeof window === 'undefined' ? DEFAULT_SIDEBAR_PEEK : readStoredSidebarPeek(window.localStorage),
  setEnabled: (enabled) => {
    storeSidebarPeek(window.localStorage, enabled)
    set({ enabled })
  }
}))

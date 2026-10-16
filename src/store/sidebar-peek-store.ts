import { create } from 'zustand'
import {
  DEFAULT_RIGHT_PANEL_PEEK,
  DEFAULT_SIDEBAR_PEEK,
  readStoredRightPanelPeek,
  readStoredSidebarPeek,
  storeRightPanelPeek,
  storeSidebarPeek
} from '@/lib/sidebar-peek'

export interface SidebarPeekStore {
  /** Left edge: the hidden sidebar peeks in. */
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  /** Right edge: the hidden right panel (Preview / Git / War Room) peeks in. */
  rightEnabled: boolean
  setRightEnabled: (enabled: boolean) => void
}

/**
 * Whether a hidden sidebar / right panel peeks in as an overlay when the
 * pointer reaches the window edge. Reads the persisted choices on creation and
 * writes every change back to localStorage. Renderer-only — touches `window`.
 */
export const useSidebarPeekStore = create<SidebarPeekStore>((set) => ({
  enabled:
    typeof window === 'undefined' ? DEFAULT_SIDEBAR_PEEK : readStoredSidebarPeek(window.localStorage),
  setEnabled: (enabled) => {
    storeSidebarPeek(window.localStorage, enabled)
    set({ enabled })
  },
  rightEnabled:
    typeof window === 'undefined' ? DEFAULT_RIGHT_PANEL_PEEK : readStoredRightPanelPeek(window.localStorage),
  setRightEnabled: (enabled) => {
    storeRightPanelPeek(window.localStorage, enabled)
    set({ rightEnabled: enabled })
  }
}))

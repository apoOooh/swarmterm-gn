import { create } from 'zustand'
import { DEFAULT_SIDEBAR_LAYOUT, readSidebarLayout, storeSidebarLayout, type SidebarLayout } from '@/lib/sidebar-layout'

export interface SidebarLayoutStore {
  layout: SidebarLayout
  setLayout: (layout: SidebarLayout) => void
}

/** Persisted sidebar split mode; renderer-only, like navbar-visibility-store. */
export const useSidebarLayoutStore = create<SidebarLayoutStore>((set) => ({
  layout: typeof window === 'undefined' ? DEFAULT_SIDEBAR_LAYOUT : readSidebarLayout(window.localStorage),
  setLayout: (layout) => {
    storeSidebarLayout(window.localStorage, layout)
    set({ layout })
  }
}))

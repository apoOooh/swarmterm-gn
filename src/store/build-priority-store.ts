import { create } from 'zustand'
import { readLowerBuildPriority, storeLowerBuildPriority } from '@/lib/build-priority'

export interface BuildPriorityStore {
  /** Settings → Terminal "Lower build priority" (on by default). */
  lowerBuildPriority: boolean
  setLowerBuildPriority: (on: boolean) => void
}

/** Persisted in localStorage; App.tsx pushes it (plus the workspace opt-outs) to Rust. */
export const useBuildPriorityStore = create<BuildPriorityStore>((set) => ({
  lowerBuildPriority: typeof window === 'undefined' ? true : readLowerBuildPriority(window.localStorage),
  setLowerBuildPriority: (on) => {
    storeLowerBuildPriority(window.localStorage, on)
    set({ lowerBuildPriority: on })
  }
}))

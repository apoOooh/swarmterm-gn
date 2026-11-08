import { create } from 'zustand'
import { DEFAULT_PRIORITY, parsePriority, readPriority, storePriority, type PrioritySettings } from '@/lib/build-priority'

export interface BuildPriorityStore {
  /** Settings → Terminal "Process priority" (strict by default). */
  priority: PrioritySettings
  setPriority: (patch: Partial<PrioritySettings>) => void
}

/** Persisted in localStorage; App.tsx pushes it (plus the workspace opt-outs) to Rust. */
export const useBuildPriorityStore = create<BuildPriorityStore>((set, get) => ({
  priority: typeof window === 'undefined' ? { ...DEFAULT_PRIORITY } : readPriority(window.localStorage),
  setPriority: (patch) => {
    const next = parsePriority({ ...get().priority, ...patch })
    storePriority(window.localStorage, next)
    set({ priority: next })
  }
}))

import { create } from 'zustand'
import {
  DEFAULT_PANE_STATUS_PREFS,
  readStoredPaneStatusPrefs,
  storePaneStatusPrefs,
  type GradientMinutes,
  type PaneStatusPrefs
} from '@/lib/pane-status-pref'

export interface PaneStatusPrefStore {
  prefs: PaneStatusPrefs
  setEnabled: (on: boolean) => void
  setGradientMinutes: (minutes: GradientMinutes) => void
}

/**
 * Pane status highlight preferences. Reads the persisted choice on first
 * creation and writes every change back to localStorage. Renderer-only.
 */
export const usePaneStatusPrefStore = create<PaneStatusPrefStore>((set, get) => {
  const initial =
    typeof window === 'undefined' ? DEFAULT_PANE_STATUS_PREFS : readStoredPaneStatusPrefs(window.localStorage)
  const apply = (prefs: PaneStatusPrefs): void => {
    storePaneStatusPrefs(window.localStorage, prefs)
    set({ prefs })
  }
  return {
    prefs: initial,
    setEnabled: (on) => apply({ ...get().prefs, enabled: on }),
    setGradientMinutes: (minutes) => apply({ ...get().prefs, gradientMinutes: minutes })
  }
})

import { create } from 'zustand'
import {
  DEFAULT_MARKDOWN_PREFS,
  readStoredMarkdownPrefs,
  storeMarkdownPrefs,
  type MarkdownMode,
  type MarkdownPrefs
} from '@/lib/markdown-pref'

export interface MarkdownPrefStore {
  prefs: MarkdownPrefs
  setDefaultMode: (mode: MarkdownMode) => void
  setMarktextPath: (path: string) => void
}

/**
 * Markdown preferences. Reads the persisted choice on first creation and
 * writes every change back to localStorage. Renderer-only — touches `window`.
 */
export const useMarkdownPrefStore = create<MarkdownPrefStore>((set, get) => {
  const initial =
    typeof window === 'undefined' ? DEFAULT_MARKDOWN_PREFS : readStoredMarkdownPrefs(window.localStorage)
  const apply = (prefs: MarkdownPrefs): void => {
    storeMarkdownPrefs(window.localStorage, prefs)
    set({ prefs })
  }
  return {
    prefs: initial,
    setDefaultMode: (mode) => apply({ ...get().prefs, defaultMode: mode }),
    setMarktextPath: (path) => apply({ ...get().prefs, marktextPath: path.trim() })
  }
})

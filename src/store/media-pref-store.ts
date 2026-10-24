import { create } from 'zustand'
import { DEFAULT_MEDIA_PREFS, readStoredMediaPrefs, storeMediaPrefs, normalizeMediaPrefs, type MediaPrefs } from '@/lib/media-overlay'

export interface MediaPrefStore {
  prefs: MediaPrefs
  update: (patch: Partial<MediaPrefs>) => void
}

/** Media overlay + clipboard-image preferences, persisted to localStorage. */
export const useMediaPrefStore = create<MediaPrefStore>((set, get) => ({
  prefs: typeof window === 'undefined' ? DEFAULT_MEDIA_PREFS : readStoredMediaPrefs(window.localStorage),
  update: (patch) => {
    const prefs = normalizeMediaPrefs({ ...get().prefs, ...patch })
    storeMediaPrefs(window.localStorage, prefs)
    set({ prefs })
  },
}))

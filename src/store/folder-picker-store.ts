import { create } from 'zustand'
import { readFavorites, storeFavorites, toggleFavorite } from '@/lib/folder-picker'

/**
 * The in-app folder picker is a single app-wide overlay (FolderPicker, mounted
 * once in App). Callers await `pickFolder(startDir)` exactly like the old
 * native dialog; the overlay settles the promise on choose/cancel. A second
 * request while one is open cancels the first (resolves null) rather than
 * stacking overlays.
 */
interface PickerRequest {
  startDir: string
  resolve: (path: string | null) => void
}

interface FolderPickerState {
  request: PickerRequest | null
  favorites: string[]
  open: (startDir?: string) => Promise<string | null>
  settle: (path: string | null) => void
  toggleFavorite: (path: string) => void
}

export const useFolderPickerStore = create<FolderPickerState>((set, get) => ({
  request: null,
  favorites: [],
  open: (startDir) => new Promise((resolve) => {
    get().request?.resolve(null)
    // Favorites are read per open (not at module load) so node tests can
    // import the store without a window.
    set({ request: { startDir: startDir ?? '', resolve }, favorites: readFavorites(window.localStorage) })
  }),
  settle: (path) => {
    const req = get().request
    set({ request: null })
    req?.resolve(path)
  },
  toggleFavorite: (path) => {
    const next = toggleFavorite(get().favorites, path)
    set({ favorites: next })
    storeFavorites(window.localStorage, next)
  }
}))

/** Open the in-app folder picker; resolves to the chosen folder or null. */
export const pickFolder = (startDir?: string): Promise<string | null> =>
  useFolderPickerStore.getState().open(startDir)

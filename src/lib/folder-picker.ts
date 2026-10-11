/**
 * Pure rules for the in-app folder picker (FolderPicker overlay): persisted
 * favorites, the quick-access list, name filtering and the "typed a path"
 * split. The overlay only wires these to the DOM and the list_folders bridge.
 */
import { folderName } from './recent-folders'

export const FAVORITES_STORAGE_KEY = 'swarmterm-folder-favorites'
/** Quick-access recents shown under the favorites. */
export const MAX_QUICK_RECENTS = 10

export interface FavoritesStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function readFavorites(storage: Pick<FavoritesStorage, 'getItem'>): string[] {
  const raw = storage.getItem(FAVORITES_STORAGE_KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  } catch {
    return []
  }
}

export function storeFavorites(storage: Pick<FavoritesStorage, 'setItem'>, list: string[]): void {
  storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(list))
}

/** Normalized key: Windows paths are case-insensitive and accept either slash. */
function key(path: string): string {
  return path.trim().replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function samePath(a: string, b: string): boolean {
  return key(a) === key(b)
}

/** Add `path` at the end, or remove it when already a favorite. */
export function toggleFavorite(list: string[], path: string): string[] {
  const trimmed = path.trim()
  if (trimmed === '') return list
  return list.some((p) => samePath(p, trimmed)) ? list.filter((p) => !samePath(p, trimmed)) : [...list, trimmed]
}

/**
 * Favorites first (user order), then recents — the recent-folders list merged
 * with saved workspace folders (already newest first) — minus anything that is
 * a favorite or a duplicate.
 */
export function quickAccess(
  favorites: string[],
  recents: string[],
  saved: ReadonlyArray<{ cwd: string }>
): { favorites: string[]; recents: string[] } {
  const seen = new Set(favorites.map(key))
  const out: string[] = []
  for (const p of [...recents, ...saved.map((s) => s.cwd)]) {
    const k = key(p)
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    out.push(p)
    if (out.length === MAX_QUICK_RECENTS) break
  }
  return { favorites, recents: out }
}

/** Case-insensitive match on the folder NAME; names starting with the query first. */
export function filterFolders(folders: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  if (q === '') return folders
  const prefix: string[] = []
  const inner: string[] = []
  for (const f of folders) {
    const name = folderName(f).toLowerCase()
    if (name.startsWith(q)) prefix.push(f)
    else if (name.includes(q)) inner.push(f)
  }
  return [...prefix, ...inner]
}

const ABSOLUTE = /^([a-zA-Z]:|[\\/])/

/**
 * Interpret the picker's input box. An absolute path navigates: everything up
 * to the last separator is the folder to list, the rest filters it (so typing
 * `C:\Code\sw` lists C:\Code filtered by "sw"). Anything else filters the
 * current folder (`dir: null`).
 */
export function splitTypedPath(input: string): { dir: string | null; filter: string } {
  const text = input.trim()
  if (!ABSOLUTE.test(text)) return { dir: null, filter: text }
  if (/^[a-zA-Z]:$/.test(text)) return { dir: `${text}\\`, filter: '' }
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  return { dir: text.slice(0, cut + 1), filter: text.slice(cut + 1) }
}

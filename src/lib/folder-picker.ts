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

/**
 * The folder "Select" may return, or null. Only a listing that belongs to the
 * latest navigation counts: while a newer request is pending or has failed,
 * the old listing is still on screen but no longer what the user asked for,
 * so selecting it would silently hand back the previous folder.
 */
export function selectableFolder(nav: {
  listing: { path: string } | null
  pending: boolean
  error: string | null
}): string | null {
  if (nav.pending || nav.error !== null || nav.listing === null) return null
  return nav.listing.path === '' ? null : nav.listing.path
}

/**
 * The folder a typed/pasted input will navigate to, or null when it only
 * filters (or names the folder already shown). The overlay marks the picker
 * pending the moment this is non-null — before the listing debounce fires —
 * so an immediate Select/Ctrl+Enter cannot return the previously shown folder.
 */
export function typedNavigation(input: string, current: string): string | null {
  const { dir } = splitTypedPath(input)
  return dir === null || samePath(dir, current) ? null : dir
}

/**
 * Whether the dialog-level Enter handler may act. Only the path box and the
 * folder list own Enter; on a button (Cancel, Windows dialog, favorites…)
 * Enter must stay the browser's activation of that button.
 */
export function pickerOwnsEnter(target: { tagName: string; inListbox: boolean }): boolean {
  if (target.tagName.toUpperCase() === 'BUTTON') return false
  return target.tagName.toUpperCase() === 'INPUT' || target.inListbox
}

export type EnterAction =
  | { kind: 'select'; path: string }
  | { kind: 'open'; index: number }
  | { kind: 'navigate'; dir: string }
  | { kind: 'none' }

/**
 * What Enter does in the path box / list. While a navigation is pending the
 * visible list still belongs to the OLD folder, so a list-based Enter would
 * open a subfolder of the wrong parent: instead Enter resolves the typed path
 * right away (skipping the debounce), or does nothing.
 */
export function enterAction(s: {
  ctrl: boolean
  pending: boolean
  typedDir: string | null
  visibleCount: number
  active: number
  selectable: string | null
}): EnterAction {
  if (s.pending) return !s.ctrl && s.typedDir !== null ? { kind: 'navigate', dir: s.typedDir } : { kind: 'none' }
  if (s.ctrl || s.visibleCount === 0) return s.selectable !== null ? { kind: 'select', path: s.selectable } : { kind: 'none' }
  return { kind: 'open', index: Math.min(s.active, s.visibleCount - 1) }
}

/**
 * Whether editing the input back to a plain filter must void a typed-path
 * navigation: both while its debounce is still scheduled AND after the
 * request already left — a late answer would otherwise redirect the picker.
 */
export function filterEditVoidsNavigation(s: { timerScheduled: boolean; typedRequestInFlight: boolean }): boolean {
  return s.timerScheduled || s.typedRequestInFlight
}

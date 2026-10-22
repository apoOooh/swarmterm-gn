/**
 * Media auto-show overlay: preferences, gating and the auto-hide timer.
 * Pure logic (no DOM, no stores) so the timer rules are unit-testable with
 * fake timers; `store/media-store.ts` and `MediaOverlay.tsx` wire it up.
 */
import type { MediaItem } from '@/lib/media-gallery'

/** Where a new gallery item came from; each origin has its own overlay toggle. */
export type MediaOrigin = 'agent' | 'clipboard'

export interface MediaPrefs {
  /** Corner popup when new media arrives. Off by default: it is an interruption. */
  overlay: boolean
  overlayTimeoutSec: number
  overlayMaxItems: number
  /** Overlay for `media.show` and paths found in pane output. */
  overlayAgent: boolean
  /** Overlay for clipboard images (only matters while `clipboardImages` is on). */
  overlayClipboard: boolean
  /** Watch the clipboard for images at all. Off by default: contents may be private. */
  clipboardImages: boolean
}

export const DEFAULT_MEDIA_PREFS: MediaPrefs = {
  overlay: false,
  overlayTimeoutSec: 6,
  overlayMaxItems: 8,
  overlayAgent: true,
  overlayClipboard: true,
  clipboardImages: false,
}

export const OVERLAY_TIMEOUT_RANGE = { min: 2, max: 60 } as const
export const OVERLAY_MAX_ITEMS_RANGE = { min: 1, max: 30 } as const

export const MEDIA_PREF_STORAGE_KEY = 'cc-media-prefs'

export interface MediaPrefStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const clampInt = (v: unknown, range: { min: number; max: number }, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(range.max, Math.max(range.min, Math.round(v))) : fallback

/** Out-of-range numbers are clamped; any other invalid field falls back alone. */
export function normalizeMediaPrefs(raw: unknown): MediaPrefs {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const bool = (k: keyof MediaPrefs): boolean =>
    typeof o[k] === 'boolean' ? (o[k] as boolean) : (DEFAULT_MEDIA_PREFS[k] as boolean)
  return {
    overlay: bool('overlay'),
    overlayTimeoutSec: clampInt(o.overlayTimeoutSec, OVERLAY_TIMEOUT_RANGE, DEFAULT_MEDIA_PREFS.overlayTimeoutSec),
    overlayMaxItems: clampInt(o.overlayMaxItems, OVERLAY_MAX_ITEMS_RANGE, DEFAULT_MEDIA_PREFS.overlayMaxItems),
    overlayAgent: bool('overlayAgent'),
    overlayClipboard: bool('overlayClipboard'),
    clipboardImages: bool('clipboardImages'),
  }
}

export function readStoredMediaPrefs(storage: MediaPrefStorage): MediaPrefs {
  const raw = storage.getItem(MEDIA_PREF_STORAGE_KEY)
  if (raw === null) return DEFAULT_MEDIA_PREFS
  try {
    return normalizeMediaPrefs(JSON.parse(raw))
  } catch {
    return DEFAULT_MEDIA_PREFS
  }
}

export function storeMediaPrefs(storage: MediaPrefStorage, prefs: MediaPrefs): void {
  storage.setItem(MEDIA_PREF_STORAGE_KEY, JSON.stringify(prefs))
}

export function overlayAllows(prefs: MediaPrefs, origin: MediaOrigin): boolean {
  if (!prefs.overlay) return false
  return origin === 'agent' ? prefs.overlayAgent : prefs.clipboardImages && prefs.overlayClipboard
}

const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Newest first; a re-announced path moves to the front instead of duplicating. */
export function pushOverlayItem(items: MediaItem[], item: MediaItem, max: number): MediaItem[] {
  return [item, ...items.filter((i) => !samePath(i.path, item.path))].slice(0, Math.max(1, max))
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * Auto-hide for the overlay. `show` (new item) and `touch` (scroll) restart
 * the countdown unless the user is interacting; `pause` (pointer enter)
 * holds it indefinitely and `resume` (pointer leave) starts a FULL timeout
 * again, so the popup never vanishes right under the pointer.
 */
export interface AutoHide {
  show: () => void
  touch: () => void
  pause: () => void
  resume: () => void
  /** Explicit dismiss: stops the timer and clears the pause. */
  stop: () => void
  readonly paused: boolean
}

export function createAutoHide(timeoutMs: () => number, onHide: () => void, timers: Timers = realTimers): AutoHide {
  let handle: unknown = null
  let paused = false
  const clear = (): void => {
    if (handle !== null) timers.clear(handle)
    handle = null
  }
  const arm = (): void => {
    clear()
    if (paused) return
    handle = timers.set(() => {
      handle = null
      onHide()
    }, timeoutMs())
  }
  return {
    show: arm,
    touch: () => {
      if (handle !== null) arm()
    },
    pause: () => {
      paused = true
      clear()
    },
    resume: () => {
      paused = false
      arm()
    },
    stop: () => {
      paused = false
      clear()
    },
    get paused() {
      return paused
    },
  }
}

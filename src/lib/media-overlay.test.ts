import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAutoHide,
  DEFAULT_MEDIA_PREFS,
  MEDIA_PREF_STORAGE_KEY,
  normalizeMediaPrefs,
  overlayAllows,
  pushOverlayItem,
  readStoredMediaPrefs,
} from './media-overlay'
import type { MediaItem } from './media-gallery'

const item = (path: string, shownAt = 1): MediaItem => ({ path, kind: 'image', terminalId: 't', source: 'pane', shownAt })

describe('media prefs', () => {
  it('defaults keep both the overlay and clipboard watching off', () => {
    expect(DEFAULT_MEDIA_PREFS.overlay).toBe(false)
    expect(DEFAULT_MEDIA_PREFS.clipboardImages).toBe(false)
  })

  it('parses per field, clamps numbers and survives junk', () => {
    const store = (v: string) => ({ getItem: (k: string) => (k === MEDIA_PREF_STORAGE_KEY ? v : null), setItem: () => {} })
    expect(readStoredMediaPrefs(store('not json'))).toEqual(DEFAULT_MEDIA_PREFS)
    const p = readStoredMediaPrefs(store(JSON.stringify({ overlay: true, overlayTimeoutSec: 999, overlayMaxItems: 0, clipboardImages: 'yes' })))
    expect(p.overlay).toBe(true)
    expect(p.overlayTimeoutSec).toBe(60)
    expect(p.overlayMaxItems).toBe(1)
    expect(p.clipboardImages).toBe(false)
    expect(normalizeMediaPrefs(null)).toEqual(DEFAULT_MEDIA_PREFS)
  })

  it('gates the overlay per origin; clipboard also needs clipboard watching', () => {
    const on = { ...DEFAULT_MEDIA_PREFS, overlay: true }
    expect(overlayAllows(DEFAULT_MEDIA_PREFS, 'agent')).toBe(false)
    expect(overlayAllows(on, 'agent')).toBe(true)
    expect(overlayAllows({ ...on, overlayAgent: false }, 'agent')).toBe(false)
    expect(overlayAllows(on, 'clipboard')).toBe(false)
    expect(overlayAllows({ ...on, clipboardImages: true }, 'clipboard')).toBe(true)
    expect(overlayAllows({ ...on, clipboardImages: true, overlayClipboard: false }, 'clipboard')).toBe(false)
  })
})

describe('pushOverlayItem', () => {
  it('prepends, dedupes case-insensitively and caps', () => {
    let list = pushOverlayItem([], item('C:/a.png'), 2)
    list = pushOverlayItem(list, item('C:/b.png'), 2)
    list = pushOverlayItem(list, item('c:/A.png', 2), 2)
    expect(list.map((i) => i.path)).toEqual(['c:/A.png', 'C:/b.png'])
    list = pushOverlayItem(list, item('C:/c.png'), 2)
    expect(list.map((i) => i.path)).toEqual(['C:/c.png', 'c:/A.png'])
  })
})

describe('createAutoHide', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hides after the timeout and a new item restarts it', () => {
    const onHide = vi.fn()
    const h = createAutoHide(() => 1000, onHide)
    h.show()
    vi.advanceTimersByTime(800)
    h.show()
    vi.advanceTimersByTime(800)
    expect(onHide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(onHide).toHaveBeenCalledTimes(1)
  })

  it('pause holds indefinitely, resume starts a full timeout', () => {
    const onHide = vi.fn()
    const h = createAutoHide(() => 1000, onHide)
    h.show()
    h.pause()
    h.show() // a new item while hovered must not arm the timer
    vi.advanceTimersByTime(10_000)
    expect(onHide).not.toHaveBeenCalled()
    h.resume()
    vi.advanceTimersByTime(999)
    expect(onHide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onHide).toHaveBeenCalledTimes(1)
  })

  it('touch resets only a running countdown; stop cancels', () => {
    const onHide = vi.fn()
    const h = createAutoHide(() => 1000, onHide)
    h.touch()
    vi.advanceTimersByTime(5000)
    expect(onHide).not.toHaveBeenCalled()
    h.show()
    vi.advanceTimersByTime(900)
    h.touch()
    vi.advanceTimersByTime(900)
    expect(onHide).not.toHaveBeenCalled()
    h.stop()
    vi.advanceTimersByTime(5000)
    expect(onHide).not.toHaveBeenCalled()
    expect(h.paused).toBe(false)
  })

  it('reads the timeout at arm time so a settings change applies to the next item', () => {
    let ms = 1000
    const onHide = vi.fn()
    const h = createAutoHide(() => ms, onHide)
    ms = 3000
    h.show()
    vi.advanceTimersByTime(2000)
    expect(onHide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(onHide).toHaveBeenCalledTimes(1)
  })
})

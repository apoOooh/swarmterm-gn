import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const registerOpenedMedia = vi.fn<(path: string) => Promise<string>>()
vi.mock('@/tauri/files', () => ({ registerOpenedMedia: (p: string) => registerOpenedMedia(p) }))
import { useMediaStore } from './media-store'
import { useMediaPrefStore } from './media-pref-store'
import { DEFAULT_MEDIA_PREFS } from '@/lib/media-overlay'
import type { MediaItem } from '@/lib/media-gallery'

const item = (path: string): MediaItem => ({ path, kind: 'image', terminalId: '', source: 'clipboard', shownAt: 1, opened: true })

describe('media overlay store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useMediaPrefStore.setState({ prefs: { ...DEFAULT_MEDIA_PREFS, overlay: true, clipboardImages: true, overlayTimeoutSec: 2, overlayMaxItems: 2 } })
    useMediaStore.setState({ overlayItems: [], overlayVisible: false })
  })
  afterEach(() => {
    useMediaStore.getState().dismissOverlay()
    vi.useRealTimers()
  })

  it('shows, caps the list and auto-hides after the configured timeout', () => {
    const m = useMediaStore.getState()
    m.announce(item('a.png'), 'clipboard')
    m.announce(item('b.png'), 'agent')
    m.announce(item('c.png'), 'agent')
    expect(useMediaStore.getState().overlayVisible).toBe(true)
    expect(useMediaStore.getState().overlayItems.map((i) => i.path)).toEqual(['c.png', 'b.png'])
    vi.advanceTimersByTime(2000)
    expect(useMediaStore.getState().overlayVisible).toBe(false)
  })

  it('stays hidden when the prefs disallow the origin', () => {
    useMediaPrefStore.setState({ prefs: { ...DEFAULT_MEDIA_PREFS } })
    useMediaStore.getState().announce(item('a.png'), 'agent')
    expect(useMediaStore.getState().overlayVisible).toBe(false)
    expect(useMediaStore.getState().overlayItems).toEqual([])
  })

  it('dismiss hides at once', () => {
    useMediaStore.getState().announce(item('a.png'), 'agent')
    useMediaStore.getState().dismissOverlay()
    expect(useMediaStore.getState().overlayVisible).toBe(false)
  })
})

describe('media open (user action)', () => {
  beforeEach(() => {
    registerOpenedMedia.mockReset()
    useMediaStore.setState({ items: [], selectedPath: null, overlayItems: [], unseen: {} })
  })

  it('detection alone registers nothing; opening registers once and selects', async () => {
    const m = useMediaStore.getState()
    m.detect({ ...item('C:\\a.png'), terminalId: 't', opened: false })
    expect(registerOpenedMedia).not.toHaveBeenCalled()
    registerOpenedMedia.mockResolvedValue('C:\\a.png')
    expect(await m.open('C:\\a.png')).toBe(true)
    expect(registerOpenedMedia).toHaveBeenCalledTimes(1)
    expect(useMediaStore.getState().items[0].opened).toBe(true)
    expect(useMediaStore.getState().selectedPath).toBe('C:\\a.png')
    await m.open('C:\\a.png')
    expect(registerOpenedMedia).toHaveBeenCalledTimes(1)
  })

  it('a refused registration drops the item', async () => {
    useMediaStore.getState().detect({ ...item('C:\\b.png'), terminalId: 't', opened: false })
    registerOpenedMedia.mockRejectedValue('gone')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await useMediaStore.getState().open('C:\\b.png')).toBe(false)
    expect(useMediaStore.getState().items).toEqual([])
  })
})

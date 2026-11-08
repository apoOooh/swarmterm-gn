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

  it('detection registers once for the thumbnail without selecting; opening then only selects', async () => {
    registerOpenedMedia.mockResolvedValue('C:\\a.png')
    const m = useMediaStore.getState()
    useMediaStore.setState({ selectedPath: 'C:\\other.png' })
    m.detect({ ...item('C:\\a.png'), terminalId: 't', opened: false })
    await vi.waitFor(() => expect(useMediaStore.getState().items[0].opened).toBe(true))
    expect(registerOpenedMedia).toHaveBeenCalledTimes(1)
    expect(useMediaStore.getState().selectedPath).toBe('C:\\other.png')
    expect(await m.open('C:\\a.png')).toBe(true)
    expect(registerOpenedMedia).toHaveBeenCalledTimes(1)
    expect(useMediaStore.getState().selectedPath).toBe('C:\\a.png')
  })

  it('a refused registration drops the detected item', async () => {
    registerOpenedMedia.mockRejectedValue('gone')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    useMediaStore.getState().detect({ ...item('C:\\b.png'), terminalId: 't', opened: false })
    await vi.waitFor(() => expect(useMediaStore.getState().items).toEqual([]))
    expect(await useMediaStore.getState().open('C:\\b.png')).toBe(false)
  })
})

describe('media gallery store', () => {
  it('matches paths case-insensitively for select and badge counts', () => {
    useMediaStore.setState({ items: [], selectedPath: null, unseen: {} })
    const m = useMediaStore.getState()
    m.detect({ ...item('C:/a/Shot.png'), terminalId: 't1', source: 'pane' })
    m.detect({ ...item('c:/A/shot.PNG'), terminalId: 't1', source: 'pane' })
    expect(useMediaStore.getState().unseen).toEqual({ t1: 1 })
    m.select('C:/A/SHOT.png')
    expect(useMediaStore.getState().unseen).toEqual({})
  })

  it('dropClipboard removes clipboard items and a clipboard selection only', () => {
    useMediaStore.setState({ items: [], selectedPath: null, unseen: {}, overlayItems: [] })
    const m = useMediaStore.getState()
    m.add(item('clip.png'))
    m.detect({ ...item('pane.png'), terminalId: 't1', source: 'pane' })
    m.detect({ ...item('named.png'), terminalId: 't2', source: 'clipboard' })
    useMediaStore.setState({ overlayItems: [item('clip.png')] })
    m.dropClipboard()
    const s = useMediaStore.getState()
    expect(s.items.map((i) => i.path)).toEqual(['named.png', 'pane.png'])
    expect(s.overlayItems).toEqual([])
    expect(s.selectedPath).toBeNull()
  })
})

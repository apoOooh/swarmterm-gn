import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every offered path "exists" with the current fake stamp.
const disk = vi.hoisted(() => ({ mtimeMs: 1, size: 10 }))
vi.mock('@/tauri/files', () => ({
  checkDetectedMedia: vi.fn(async (_terminalId: string, paths: string[]) => paths.map((path) => ({ path, ...disk }))),
  registerOpenedMedia: vi.fn(async () => {})
}))

const media = vi.hoisted(() => ({ detect: vi.fn((_item: unknown) => true), announce: vi.fn(), clearUnseen: vi.fn() }))
vi.mock('@/store/media-store', () => ({ useMediaStore: { getState: () => media } }))

import { FOUND_RECHECK_MS } from '@/lib/media-detect'
import { forgetMediaOutput, MAX_PENDING_BYTES, noteHookMedia, noteMediaOutput, SCAN_INTERVAL_MS } from '@/lib/media-passive'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

async function detectedAfterScan(): Promise<string[]> {
  await vi.advanceTimersByTimeAsync(SCAN_INTERVAL_MS * 3)
  return media.detect.mock.calls.map(([item]) => (item as { path: string }).path)
}

describe('noteMediaOutput', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    forgetMediaOutput('t1')
    media.detect.mockClear()
    media.announce.mockClear()
    disk.mtimeMs = 1
    vi.useRealTimers()
  })

  it('detects a path delivered as a string batch (small-batch string writes)', async () => {
    noteMediaOutput('t1', 'saved C:\\shots\\one.png\r\n')
    expect(await detectedAfterScan()).toEqual(['C:\\shots\\one.png'])
  })

  it('detects paths across mixed byte and string chunks', async () => {
    noteMediaOutput('t1', bytes('saved C:\\shots\\two.png\r\n'))
    noteMediaOutput('t1', 'saved C:\\shots\\three.png\r\n')
    expect(await detectedAfterScan()).toEqual(['C:\\shots\\two.png', 'C:\\shots\\three.png'])
  })

  it('keeps the order across a byte-split UTF-8 sequence followed by a string', async () => {
    const all = bytes('saved C:\\shots\\é.png')
    // Cut inside the 2-byte é: the decoder holds its first byte.
    const cut = all.indexOf(0xc3) + 1
    noteMediaOutput('t1', all.subarray(0, cut))
    noteMediaOutput('t1', all.subarray(cut))
    noteMediaOutput('t1', ' and C:\\shots\\four.png\r\n')
    expect(await detectedAfterScan()).toEqual(['C:\\shots\\é.png', 'C:\\shots\\four.png'])
  })

  it('drops the oldest string chunks past the pending cap', async () => {
    noteMediaOutput('t1', 'saved C:\\shots\\old.png\r\n')
    noteMediaOutput('t1', 'x'.repeat(MAX_PENDING_BYTES) + '\r\n')
    noteMediaOutput('t1', 'saved C:\\shots\\new.png\r\n')
    expect(await detectedAfterScan()).toEqual(['C:\\shots\\new.png'])
  })

  it('re-announces a file overwritten in place, but not an unchanged reprint', async () => {
    const shot = 'saved C:/scratch/xs.png\r\n'
    noteMediaOutput('t1', shot)
    expect(await detectedAfterScan()).toEqual(['C:/scratch/xs.png'])
    // Redraw within the recheck interval: no lookup at all.
    noteMediaOutput('t1', shot)
    await vi.advanceTimersByTimeAsync(FOUND_RECHECK_MS)
    // Reprint after it with the same stamp: looked up, not news.
    noteMediaOutput('t1', shot)
    expect(await detectedAfterScan()).toHaveLength(1)
    disk.mtimeMs = 2
    await vi.advanceTimersByTimeAsync(FOUND_RECHECK_MS)
    noteMediaOutput('t1', shot)
    expect(await detectedAfterScan()).toHaveLength(2)
    expect(media.announce).toHaveBeenCalledTimes(2)
    const items = media.detect.mock.calls.map(([i]) => i as { shownAt: number; version: string })
    expect(items[1].version).toBe('2:10')
    expect(items[1].shownAt).toBeGreaterThan(items[0].shownAt)
  })

  it('does not announce what the store says is not news (another pane found the same version)', async () => {
    media.detect.mockReturnValueOnce(false)
    noteMediaOutput('t1', 'saved C:/scratch/seen.png\r\n')
    expect(await detectedAfterScan()).toEqual(['C:/scratch/seen.png'])
    expect(media.announce).not.toHaveBeenCalled()
  })
})

describe('noteHookMedia', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    media.detect.mockClear()
    media.announce.mockClear()
  })
  afterEach(() => {
    forgetMediaOutput('t1')
    media.detect.mockClear()
    media.announce.mockClear()
    disk.mtimeMs = 1
    vi.useRealTimers()
  })

  it('detects and announces a hook-reported file once, also against the screen scan', async () => {
    noteHookMedia('t1', 'C:\\scratch\\w1.jpg', 1, 10)
    noteHookMedia('t1', 'c:\\SCRATCH\\w1.jpg', 1, 10)
    expect(media.detect).toHaveBeenCalledTimes(1)
    expect(media.announce).toHaveBeenCalledTimes(1)
    expect(media.detect.mock.calls[0][0]).toMatchObject({ path: 'C:\\scratch\\w1.jpg', kind: 'image', terminalId: 't1', opened: false })
    // The agent's reply names the same file: no second announcement.
    noteMediaOutput('t1', 'Looked at C:\\scratch\\w1.jpg\r\n')
    expect(await detectedAfterScan()).toEqual(['C:\\scratch\\w1.jpg'])
    expect(media.announce).toHaveBeenCalledTimes(1)
    // Control: on its own, the screen scan does announce that line.
    noteMediaOutput('t1', 'Looked at C:\\scratch\\w2.jpg\r\n')
    expect(await detectedAfterScan()).toEqual(['C:\\scratch\\w1.jpg', 'C:\\scratch\\w2.jpg'])
    expect(media.announce).toHaveBeenCalledTimes(2)
  })

  it('re-announces a hook-reported file overwritten in place, but not an unchanged Read', () => {
    noteHookMedia('t1', 'C:/scratch/shot.png', 1, 10)
    noteHookMedia('t1', 'C:/scratch/shot.png', 1, 10)
    expect(media.announce).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5)
    noteHookMedia('t1', 'C:/scratch/shot.png', 2, 12)
    expect(media.announce).toHaveBeenCalledTimes(2)
    const items = media.detect.mock.calls.map(([i]) => i as { shownAt: number; version: string })
    expect(items.map((i) => i.version)).toEqual(['1:10', '2:12'])
    expect(items[1].shownAt).toBeGreaterThan(items[0].shownAt)
    noteHookMedia('t1', 'C:/scratch/shot.png', 2, 12)
    expect(media.announce).toHaveBeenCalledTimes(2)
  })

  it('a screen hit after the hook stays silent for the same stamp, refreshes for a new one', async () => {
    noteHookMedia('t1', 'C:/scratch/w3.png', 1, 10)
    await vi.advanceTimersByTimeAsync(FOUND_RECHECK_MS)
    noteMediaOutput('t1', 'saved C:/scratch/w3.png\r\n')
    expect(await detectedAfterScan()).toEqual(['C:/scratch/w3.png'])
    expect(media.announce).toHaveBeenCalledTimes(1)
    disk.mtimeMs = 2
    await vi.advanceTimersByTimeAsync(FOUND_RECHECK_MS)
    noteMediaOutput('t1', 'saved C:/scratch/w3.png\r\n')
    expect(await detectedAfterScan()).toHaveLength(2)
    expect(media.announce).toHaveBeenCalledTimes(2)
    // The hook then reports the same new version: not news twice.
    noteHookMedia('t1', 'C:/scratch/w3.png', 2, 10)
    expect(media.announce).toHaveBeenCalledTimes(2)
  })

  it('ignores non-media paths', () => {
    noteHookMedia('t1', 'C:\\scratch\\notes.txt', 1, 10)
    expect(media.detect).not.toHaveBeenCalled()
  })
})

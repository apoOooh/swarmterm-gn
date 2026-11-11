import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/tauri/files', () => ({
  // Every offered path "exists": the test is about the chunk handling.
  checkDetectedMedia: vi.fn(async (_terminalId: string, paths: string[]) => paths),
  registerOpenedMedia: vi.fn(async () => {})
}))

const media = vi.hoisted(() => ({ detect: vi.fn(), announce: vi.fn(), clearUnseen: vi.fn() }))
vi.mock('@/store/media-store', () => ({ useMediaStore: { getState: () => media } }))

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
    vi.useRealTimers()
  })

  it('detects and announces a hook-reported file once, also against the screen scan', async () => {
    noteHookMedia('t1', 'C:\\scratch\\w1.jpg')
    noteHookMedia('t1', 'c:\\SCRATCH\\w1.jpg')
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

  it('ignores non-media paths', () => {
    noteHookMedia('t1', 'C:\\scratch\\notes.txt')
    expect(media.detect).not.toHaveBeenCalled()
  })
})

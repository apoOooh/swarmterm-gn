import { describe, expect, it } from 'vitest'
import { addMediaItem, fileName, markOpened, mediaKind, type MediaItem } from '@/lib/media-gallery'

const item = (path: string, shownAt: number): MediaItem => ({ path, kind: 'image', terminalId: 't', source: 'pane', shownAt, opened: true })

describe('media gallery', () => {
  it('puts new items first and moves a re-shown path to the front', () => {
    let list = addMediaItem([], item('C:\\a.png', 1))
    list = addMediaItem(list, item('C:\\b.png', 2))
    list = addMediaItem(list, item('c:\\A.png', 3))
    expect(list.map((i) => [i.path, i.shownAt])).toEqual([['c:\\A.png', 3], ['C:\\b.png', 2]])
  })
  it('caps the list', () => {
    let list: MediaItem[] = []
    for (let n = 0; n < 5; n++) list = addMediaItem(list, item(`/${n}.png`, n), 3)
    expect(list.map((i) => i.path)).toEqual(['/4.png', '/3.png', '/2.png'])
  })
  it('keeps an opened file opened when it is detected again, and marks by path', () => {
    const detected = (p: string): MediaItem => ({ ...item(p, 1), opened: false })
    let list = addMediaItem([], detected('C:\\a.png'))
    expect(list[0].opened).toBe(false)
    list = markOpened(list, 'c:\\A.png')
    expect(list[0].opened).toBe(true)
    list = addMediaItem(list, detected('C:\\a.png'))
    expect(list[0].opened).toBe(true)
    expect(addMediaItem(list, detected('C:\\b.png'))[0].opened).toBe(false)
  })
  it('classifies kinds and names', () => {
    expect(mediaKind('x.MP4')).toBe('video')
    expect(mediaKind('x.webp')).toBe('image')
    expect(mediaKind('x.txt')).toBeNull()
    expect(fileName('C:\\tmp\\shot.png')).toBe('shot.png')
    expect(fileName('/tmp/clip.webm')).toBe('clip.webm')
  })
})

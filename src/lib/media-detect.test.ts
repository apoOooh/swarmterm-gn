import { describe, expect, it } from 'vitest'
import { detectMediaPaths, MAX_CARRY, MediaOutputBuffer, MISS_MAX_TRIES, MISS_RETRY_MS, OVERLAP, SeenPaths } from './media-detect'

describe('detectMediaPaths', () => {
  it('ignores output without a media extension', () => {
    expect(detectMediaPaths('cargo build finished in 3.2s\nsrc/main.rs:12')).toEqual([])
    expect(detectMediaPaths('file.pngx and image.png2')).toEqual([])
  })

  it('finds absolute Windows paths anywhere in a line', () => {
    expect(detectMediaPaths('Saved screenshot to C:\\Users\\me\\AppData\\Local\\Temp\\shot.png.')).toEqual([
      'C:\\Users\\me\\AppData\\Local\\Temp\\shot.png'
    ])
    expect(detectMediaPaths('-> g:/ai/out/clip.MP4, done')).toEqual(['g:/ai/out/clip.MP4'])
  })

  it('keeps spaces inside absolute and quoted paths', () => {
    expect(detectMediaPaths('wrote C:\\My Shots\\before after.jpeg')).toEqual(['C:\\My Shots\\before after.jpeg'])
    expect(detectMediaPaths('open "out dir/compare 2.webp" now')).toEqual(['out dir/compare 2.webp'])
    expect(detectMediaPaths("see 'D:\\a b\\c.gif'")).toEqual(['D:\\a b\\c.gif'])
  })

  it('finds relative paths and bare file names', () => {
    expect(detectMediaPaths('Created ./screens/home.png and ah-sheet.png')).toEqual(['./screens/home.png', 'ah-sheet.png'])
    expect(detectMediaPaths('(see ..\\docs\\demo.webm)')).toEqual(['..\\docs\\demo.webm'])
  })

  it('separates several paths on one line and dedupes', () => {
    expect(detectMediaPaths('C:\\a\\one.png vs C:\\a\\two.png vs C:\\a\\one.png')).toEqual(['C:\\a\\one.png', 'C:\\a\\two.png'])
  })

  it('strips ANSI colour around and inside a path', () => {
    expect(detectMediaPaths('\x1b[32mC:\\tmp\\\x1b[1mshot.png\x1b[0m done')).toEqual(['C:\\tmp\\shot.png'])
    expect(detectMediaPaths('\x1b]8;;file:///x\x07a/b.gif\x1b]8;;\x07')).toEqual(['a/b.gif'])
  })

  it('treats cursor moves as spaces', () => {
    expect(detectMediaPaths('Wrote\x1b[1Cshot.png')).toEqual(['shot.png'])
  })

  it('does not let a prose-swallowing drive match hide a real file', () => {
    expect(detectMediaPaths('cd C:\\proj && echo x.png')).toEqual(['x.png'])
  })

  it('leaves URLs alone', () => {
    expect(detectMediaPaths('GET https://example.com/img/logo.png 200')).toEqual([])
  })
})

describe('MediaOutputBuffer', () => {
  it('reassembles a path split across chunks before scanning', () => {
    const b = new MediaOutputBuffer()
    b.append('saved C:\\tmp\\sh')
    expect(b.take()).toBe('')
    b.append('ot.p')
    b.append('ng\r\nnext')
    expect(detectMediaPaths(b.take())).toEqual(['C:\\tmp\\shot.png'])
    expect(b.drain()).toBe('next')
  })

  it('reassembles a split escape sequence', () => {
    const b = new MediaOutputBuffer()
    b.append('a/b.png\x1b[3')
    b.append('2m\n')
    expect(detectMediaPaths(b.take())).toEqual(['a/b.png'])
  })

  it('bounds a newline-less stream but keeps an overlap for a straddling path', () => {
    const b = new MediaOutputBuffer()
    b.append('x'.repeat(MAX_CARRY) + ' C:\\t\\a.p')
    expect(b.take().length).toBe(MAX_CARRY + 9)
    b.append('ng\n')
    expect(detectMediaPaths(b.take())).toEqual(['C:\\t\\a.png'])
    expect(OVERLAP).toBeGreaterThan(9)
  })

  it('drains a partial last line', () => {
    const b = new MediaOutputBuffer()
    b.append('prompt> shot.gif')
    expect(b.take()).toBe('')
    expect(b.hasPartial).toBe(true)
    expect(b.drain()).toBe('prompt> shot.gif')
    expect(b.hasPartial).toBe(false)
  })
})

describe('SeenPaths', () => {
  it('never re-offers a confirmed path, case-insensitively', () => {
    const s = new SeenPaths()
    expect(s.offer('C:\A.png', 0)).toBe(true)
    s.confirm('C:\A.png')
    expect(s.offer('c:\a.PNG', 1e9)).toBe(false)
  })

  it('retries a miss after a delay, a bounded number of times', () => {
    const s = new SeenPaths()
    let t = 0
    expect(s.offer('out.png', t)).toBe(true)
    expect(s.offer('out.png', t + 10)).toBe(false)
    for (let i = 1; i < MISS_MAX_TRIES; i++) {
      t += MISS_RETRY_MS
      expect(s.offer('out.png', t)).toBe(true)
    }
    expect(s.offer('out.png', t + 10 * MISS_RETRY_MS)).toBe(false)
  })

  it('stays bounded', () => {
    const s = new SeenPaths(2)
    s.offer('a.png', 0); s.confirm('a.png')
    s.offer('b.png', 0); s.confirm('b.png')
    s.offer('c.png', 0); s.confirm('c.png')
    expect(s.offer('a.png', 0)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { fitView, MAX_SCALE, previewFrameUrl, previewKind, zoomAt } from './preview-kind'
describe('preview kinds', () => {
  it('recognises Markdown, SVG and HTML case-insensitively', () => {
    expect(previewKind('/p/README.md')).toBe('markdown')
    expect(previewKind('/p/icon.SVG')).toBe('svg')
    expect(previewKind('/p/index.htm')).toBe('html')
    expect(previewKind('/p/page.html')).toBe('html')
    expect(previewKind('/p/app.js')).toBeNull()
    expect(previewKind('/p/notes.svgz')).toBeNull()
  })
  it('builds a path-addressed frame URL with per-segment encoding', () => {
    expect(previewFrameUrl('http://swarmterm-media.localhost/ctx', 'C:\\My Proj\\a#b.html', 3))
      .toBe('http://swarmterm-media.localhost/ctx/f/C:/My%20Proj/a%23b.html?revision=3')
    expect(previewFrameUrl('swarmterm-media://localhost/ctx/', '/home/u/x.html', 0))
      .toBe('swarmterm-media://localhost/ctx/f/home/u/x.html?revision=0')
  })
})
describe('svg view math', () => {
  it('zooms around the cursor and clamps the scale', () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 50)).toEqual({ scale: 2, x: -100, y: -50 })
    expect(zoomAt({ scale: MAX_SCALE, x: 0, y: 0 }, 2, 0, 0).scale).toBe(MAX_SCALE)
  })
  it('fits large content and centres small content at 100 %', () => {
    expect(fitView(400, 200, 200, 200)).toEqual({ scale: 0.5, x: 0, y: 50 })
    expect(fitView(10, 10, 100, 100)).toEqual({ scale: 1, x: 45, y: 45 })
  })
})

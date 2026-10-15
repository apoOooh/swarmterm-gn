import { describe, expect, it } from 'vitest'
import { hasOpenOverlay } from './overlay-watch'

function rootWith(match: boolean): { querySelector: (s: string) => unknown } {
  return { querySelector: () => (match ? {} : null) }
}

describe('hasOpenOverlay', () => {
  it('is true when an overlay element exists', () => {
    expect(hasOpenOverlay(rootWith(true))).toBe(true)
  })
  it('is true when floating chrome marks itself as covering the webview', () => {
    const root = { querySelector: (s: string) => (s.split(',').includes('[data-covers-webview]') ? {} : null) }
    expect(hasOpenOverlay(root)).toBe(true)
  })
  it('is false when none exists', () => {
    expect(hasOpenOverlay(rootWith(false))).toBe(false)
  })
})

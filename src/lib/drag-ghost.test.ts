import { describe, expect, it } from 'vitest'
import { ghostBesideCursor, GHOST_CURSOR_OFFSET } from './drag-ghost'

describe('ghostBesideCursor', () => {
  it('moves the ghost so its top-left sits just past the pointer', () => {
    // Pane at (100,50); grabbed at (400,60) — 300px into the header.
    const t = ghostBesideCursor({ x: 30, y: 40, scaleX: 1, scaleY: 1 }, { clientX: 400, clientY: 60 }, { left: 100, top: 50 })
    expect(t).toEqual({ x: 30 + 300 + GHOST_CURSOR_OFFSET, y: 40 + 10 + GHOST_CURSOR_OFFSET, scaleX: 1, scaleY: 1 })
  })

  it('leaves the transform alone without a pointer event or rect', () => {
    const base = { x: 5, y: 6, scaleX: 1, scaleY: 1 }
    expect(ghostBesideCursor(base, null, { left: 0, top: 0 })).toBe(base)
    expect(ghostBesideCursor(base, { clientX: 1, clientY: 1 }, null)).toBe(base)
  })
})

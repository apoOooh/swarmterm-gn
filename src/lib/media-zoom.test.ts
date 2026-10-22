import { describe, expect, it } from 'vitest'
import { FIT_VIEW, canvasQuality, clampPan, fitRatio, oneToOne, panBy, scaleBounds, transformedBox, viewTransform, wheelFactor, wheelPixels, zoomAt } from './media-zoom'
import { toImage } from './media-annotate'

describe('media-zoom', () => {
  it('bounds: 10%..2000% of natural size, Fit always reachable', () => {
    expect(fitRatio({ width: 500, height: 250 }, { width: 1000, height: 500 })).toBe(0.5)
    expect(scaleBounds(0.5)).toEqual({ min: 0.2, max: 40 })
    // Huge fit (tiny image blown up): Fit is above 2000%, still allowed.
    expect(scaleBounds(50)).toEqual({ min: 0.002, max: 1 })
    expect(scaleBounds(0)).toEqual({ min: 1, max: 1 })
    expect(oneToOne(0.25)).toBe(4)
  })

  it('normalises wheel deltas by mode and limits them', () => {
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 }, 600)).toBe(48)
    expect(wheelPixels({ deltaY: 1, deltaMode: 2 }, 300)).toBe(300)
    expect(wheelPixels({ deltaY: 5000, deltaMode: 0 }, 600)).toBe(400)
    expect(wheelFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false }, 600)).toBeGreaterThan(1)
    expect(wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false }, 600)).toBeLessThan(1)
    // Pinch: small deltas, stronger gain.
    expect(wheelFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true }, 600)).toBeCloseTo(Math.exp(0.1))
    // In then out by the same delta returns to the start.
    const f = wheelFactor({ deltaY: 120, deltaMode: 0, ctrlKey: false }, 600)
    expect(f * wheelFactor({ deltaY: -120, deltaMode: 0, ctrlKey: false }, 600)).toBeCloseTo(1)
  })

  it('zoomAt keeps the point under the cursor fixed and clamps', () => {
    const layout = { left: 100, top: 50, width: 400, height: 200 }
    const natural = { width: 800, height: 400 }
    const cursor = { x: 420, y: 90 } // screen
    const rel = { x: cursor.x - 300, y: cursor.y - 150 } // relative to layout centre
    const before = toImage(cursor, transformedBox(layout, FIT_VIEW), natural)
    const v = zoomAt(FIT_VIEW, rel, 3, { min: 0.2, max: 40 })
    expect(v.s).toBe(3)
    const after = toImage(cursor, transformedBox(layout, v), natural)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(zoomAt(v, rel, 100, { min: 0.2, max: 40 }).s).toBe(40)
    expect(zoomAt(v, rel, 0.01, { min: 0.2, max: 40 }).s).toBe(0.2)
  })

  it('pointer -> image mapping follows pan', () => {
    const layout = { left: 0, top: 0, width: 400, height: 200 }
    const natural = { width: 400, height: 200 }
    const v = panBy({ s: 2, tx: 0, ty: 0 }, 50, -20)
    // Screen centre of the layout box now shows image point centre - pan / s.
    const p = toImage({ x: 200, y: 100 }, transformedBox(layout, v), natural)
    expect(p.x).toBeCloseTo(200 - 25)
    expect(p.y).toBeCloseTo(100 + 10)
    expect(viewTransform(v)).toBe('translate(50px, -20px) scale(2)')
  })

  it('pan is limited to the overhang and centred when the image fits', () => {
    const layout = { width: 400, height: 200 }
    const container = { width: 500, height: 300 }
    expect(clampPan({ s: 1, tx: 80, ty: -40 }, layout, container)).toEqual({ s: 1, tx: 0, ty: 0 })
    // s=2: 800x400 in 500x300 -> overhang 150 / 50.
    expect(clampPan({ s: 2, tx: 999, ty: -999 }, layout, container)).toEqual({ s: 2, tx: 150, ty: -50 })
  })
})

describe('canvasQuality', () => {
  it('follows zoom, at least 1, capped by pixel budget', () => {
    expect(canvasQuality(0.5, { width: 400, height: 300 }, 1)).toBe(1)
    expect(canvasQuality(3, { width: 400, height: 300 }, 1)).toBe(3)
    const q = canvasQuality(50, { width: 1000, height: 1000 }, 2)
    expect(q).toBeCloseTo(2)
  })
})

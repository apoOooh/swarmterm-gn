import { describe, expect, it } from 'vitest'
import {
  addMark, addPoint, arrowHead, clearMarks, drawMark, emptyMarks, flattenSize, imagePerScreen, isVisibleMark,
  markedName, normRect, toImage, undoMark, type Ctx2D, type Mark,
} from '@/lib/media-annotate'

const pen = (n: number): Mark => ({ tool: 'pen', color: '#f00', width: 4, points: [{ x: n, y: n }] })

describe('coordinate mapping', () => {
  const box = { left: 100, top: 50, width: 200, height: 100 }
  const natural = { width: 2000, height: 1000 }
  it('maps viewport points to image pixels and clamps outside points', () => {
    expect(toImage({ x: 200, y: 100 }, box, natural)).toEqual({ x: 1000, y: 500 })
    expect(toImage({ x: 0, y: 500 }, box, natural)).toEqual({ x: 0, y: 1000 })
    expect(imagePerScreen(box, natural)).toBe(10)
  })
  it('survives a zero-size box', () => {
    expect(toImage({ x: 1, y: 1 }, { ...box, width: 0 }, natural)).toEqual({ x: 0, y: 0 })
    expect(imagePerScreen({ ...box, width: 0 }, natural)).toBe(1)
  })
})

describe('freehand smoothing', () => {
  it('drops points closer than minDist', () => {
    let pts = addPoint([], { x: 0, y: 0 }, 2)
    pts = addPoint(pts, { x: 1, y: 1 }, 2)
    expect(pts).toHaveLength(1)
    pts = addPoint(pts, { x: 3, y: 0 }, 2)
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }])
  })
})

describe('shapes', () => {
  it('normalises a rect dragged in any direction', () => {
    const want = { x: 10, y: 20, width: 30, height: 40 }
    expect(normRect({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(want)
    expect(normRect({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(want)
    expect(normRect({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(want)
    expect(normRect({ x: 10, y: 60 }, { x: 40, y: 20 })).toEqual(want)
  })
  it('puts the arrowhead corners behind the head, symmetric about the shaft', () => {
    const [l, r] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)
    expect(l.x).toBeLessThan(100)
    expect(r.x).toBeCloseTo(l.x)
    expect(l.y).toBeCloseTo(-r.y)
    expect(Math.hypot(100 - l.x, l.y)).toBeCloseTo(16)
    // Pointing left: corners to the right of the head.
    const [l2] = arrowHead({ x: 100, y: 0 }, { x: 0, y: 0 }, 1)
    expect(l2.x).toBeGreaterThan(0)
    expect(Math.hypot(l2.x, l2.y)).toBeCloseTo(10)
  })
  it('drops a shape without a drag but keeps a freehand dot', () => {
    expect(isVisibleMark({ tool: 'rect', color: 'r', width: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBe(false)
    expect(isVisibleMark({ tool: 'arrow', color: 'r', width: 1, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] })).toBe(true)
    expect(isVisibleMark(pen(1))).toBe(true)
  })
})

describe('undo', () => {
  it('undoes adds in reverse order and restores a clear', () => {
    let s = addMark(addMark(emptyMarks(), pen(1)), pen(2))
    s = clearMarks(s)
    expect(s.marks).toEqual([])
    s = undoMark(s)
    expect(s.marks).toEqual([pen(1), pen(2)])
    s = undoMark(s)
    expect(s.marks).toEqual([pen(1)])
    s = undoMark(undoMark(s))
    expect(s).toEqual(emptyMarks())
  })
  it('ignores invisible marks and clearing nothing', () => {
    const s = emptyMarks()
    expect(addMark(s, { tool: 'line', color: 'r', width: 1, points: [{ x: 0, y: 0 }] })).toBe(s)
    expect(clearMarks(s)).toBe(s)
  })
})

describe('flatten', () => {
  it('keeps the natural size up to the cap and scales larger images down', () => {
    expect(flattenSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080, scale: 1 })
    expect(flattenSize({ width: 16384, height: 4096 })).toEqual({ width: 8192, height: 2048, scale: 0.5 })
    expect(flattenSize({ width: 100, height: 20000 }, 1000)).toEqual({ width: 5, height: 1000, scale: 0.05 })
    expect(flattenSize({ width: 0, height: 0 })).toEqual({ width: 1, height: 1, scale: 1 })
  })
  it('names the copy after the original', () => {
    expect(markedName('C:\\shots\\ui.v2.jpg')).toBe('ui.v2 (marked).png')
    expect(markedName('/tmp/noext')).toBe('noext (marked).png')
  })
})

describe('drawMark', () => {
  const recorder = (): { ctx: Ctx2D; calls: string[] } => {
    const calls: string[] = []
    const rec = (name: string) => (...args: number[]) => { calls.push(`${name}(${args.map((n) => Math.round(n)).join(',')})`) }
    const ctx = {
      globalAlpha: 1, strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
      save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
      quadraticCurveTo: rec('quad'), closePath: rec('closePath'), rect: rec('rect'), ellipse: rec('ellipse'),
      arc: rec('arc'), stroke: rec('stroke'), fill: rec('fill'),
    } as Ctx2D
    return { ctx, calls }
  }
  it('draws normalised rects and ellipses, filled only on request', () => {
    const { ctx, calls } = recorder()
    drawMark(ctx, { tool: 'rect', color: 'r', width: 2, points: [{ x: 40, y: 60 }, { x: 10, y: 20 }] })
    expect(calls).toContain('rect(10,20,30,40)')
    expect(calls).not.toContain('fill()')
    const e = recorder()
    drawMark(e.ctx, { tool: 'ellipse', color: 'r', width: 2, fill: true, points: [{ x: 0, y: 0 }, { x: 20, y: 10 }] })
    expect(e.calls).toContain('ellipse(10,5,10,5,0,0,6)')
    expect(e.calls).toContain('fill()')
  })
  it('draws the marker wide and translucent, and an arrow with a head', () => {
    const { ctx } = recorder()
    let alpha = 0
    let width = 0
    ctx.stroke = () => { alpha = ctx.globalAlpha; width = ctx.lineWidth }
    drawMark(ctx, { tool: 'marker', color: 'r', width: 4, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }] })
    expect(alpha).toBeCloseTo(0.4)
    expect(width).toBe(12)
    const a = recorder()
    drawMark(a.ctx, { tool: 'arrow', color: 'r', width: 2, points: [{ x: 0, y: 0 }, { x: 50, y: 0 }] })
    expect(a.calls.filter((c) => c === 'closePath()')).toHaveLength(1)
  })
})

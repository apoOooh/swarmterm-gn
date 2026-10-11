import { describe, it, expect } from 'vitest'
import type { LayoutNode, LeafNode, SplitNode } from './layout-tree'
import { junctionsFor, sizesForPointer, splitRects, SEPARATOR_PX } from './split-junctions'

function leaf(id: string): LeafNode {
  return { type: 'leaf', id, terminalId: `term-${id}` }
}

function split(
  id: string,
  direction: SplitNode['direction'],
  children: [LayoutNode, LayoutNode],
  sizes: [number, number] = [50, 50]
): SplitNode {
  return { type: 'split', id, direction, sizes, children }
}

const RECT = { x: 0, y: 0, w: 1008, h: 608 }

describe('splitRects', () => {
  it('lays children out around the separator', () => {
    const rects = splitRects(split('S', 'horizontal', [leaf('A'), leaf('B')]), RECT)
    expect(rects.get('S')).toEqual(RECT)
    expect(rects.get('A')).toEqual({ x: 0, y: 0, w: 500, h: 608 })
    expect(rects.get('B')).toEqual({ x: 508, y: 0, w: 500, h: 608 })
  })
})

describe('junctionsFor', () => {
  it('finds no junctions in a single split or a leaf', () => {
    expect(junctionsFor(leaf('A'), RECT)).toEqual([])
    expect(junctionsFor(split('S', 'vertical', [leaf('A'), leaf('B')]), RECT)).toEqual([])
  })

  it('finds the T-junction between a split and its perpendicular child', () => {
    const tree = split('S1', 'horizontal', [
      leaf('A'),
      split('S2', 'vertical', [leaf('B'), leaf('C')], [60, 40])
    ])
    const [j, ...rest] = junctionsFor(tree, RECT)
    expect(rest).toEqual([])
    expect(j.hSplitId).toBe('S1')
    expect(j.vSplitId).toBe('S2')
    expect(j.x).toBe(504)
    expect(j.y).toBe(360 + SEPARATOR_PX / 2)
  })

  it('finds both T-junctions of a 2x2 grid', () => {
    const tree = split('R', 'vertical', [
      split('T', 'horizontal', [leaf('A'), leaf('B')]),
      split('U', 'horizontal', [leaf('C'), leaf('D')])
    ])
    const ids = junctionsFor(tree, RECT).map((j) => `${j.hSplitId}/${j.vSplitId}`).sort()
    expect(ids).toEqual(['T/R', 'U/R'])
  })

  it('ignores perpendicular splits that do not touch the separator', () => {
    // S3 sits in the right half of S2's region, away from S1's separator.
    const tree = split('S1', 'horizontal', [
      leaf('A'),
      split('S2', 'horizontal', [leaf('B'), split('S3', 'vertical', [leaf('C'), leaf('D')])])
    ])
    const ids = junctionsFor(tree, RECT).map((j) => `${j.hSplitId}/${j.vSplitId}`)
    expect(ids).toEqual(['S2/S3'])
  })
})

describe('sizesForPointer', () => {
  const rect = { x: 0, y: 0, w: 1008, h: 608 }

  it('maps the pointer to the separator centre', () => {
    expect(sizesForPointer('horizontal', rect, { x: 504, y: 0 })).toEqual([50, 50])
    const [a, b] = sizesForPointer('vertical', rect, { x: 0, y: 304 })
    expect(a + b).toBe(100)
    expect(a).toBeCloseTo(50)
  })

  it('clamps to the minimum pane size', () => {
    expect(sizesForPointer('horizontal', rect, { x: -50, y: 0 })).toEqual([8, 92])
    expect(sizesForPointer('horizontal', rect, { x: 5000, y: 0 })).toEqual([92, 8])
  })
})

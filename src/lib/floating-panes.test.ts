import { describe, it, expect } from 'vitest'
import type { LayoutNode, LeafNode } from './layout-tree'
import {
  clampFloatRect,
  floatingAfterRemoval,
  floatPane,
  hiddenLeafIds,
  isFloating,
  unfloatPane,
  MIN_FLOAT_SIZE
} from './floating-panes'

const leaf = (id: string): LeafNode => ({ type: 'leaf', id, terminalId: `t-${id}` })
const tree: LayoutNode = {
  type: 'split', id: 'S', direction: 'horizontal', sizes: [50, 50],
  children: [leaf('A'), leaf('B')]
}

describe('floatPane', () => {
  it('adds a cascaded rect per floating pane', () => {
    const one = floatPane([], 'A')
    const two = floatPane(one, 'B')
    expect(two).toHaveLength(2)
    expect(two[1].x).toBeGreaterThan(two[0].x)
    expect(two[1].y).toBeGreaterThan(two[0].y)
  })

  it('is a no-op for a pane that already floats', () => {
    const one = floatPane([], 'A')
    expect(floatPane(one, 'A')).toBe(one)
  })
})

describe('unfloatPane / isFloating', () => {
  it('removes the pane', () => {
    const f = floatPane(floatPane([], 'A'), 'B')
    expect(isFloating(f, 'A')).toBe(true)
    const left = unfloatPane(f, 'A')
    expect(isFloating(left, 'A')).toBe(false)
    expect(left.map((r) => r.leafId)).toEqual(['B'])
  })
})

describe('clampFloatRect', () => {
  it('keeps the rect inside the workspace', () => {
    expect(clampFloatRect({ leafId: 'A', x: 0.9, y: -0.2, w: 0.5, h: 0.5 }))
      .toEqual({ leafId: 'A', x: 0.5, y: 0, w: 0.5, h: 0.5 })
  })

  it('enforces a minimum size', () => {
    const r = clampFloatRect({ leafId: 'A', x: 0, y: 0, w: 0.01, h: 2 })
    expect(r.w).toBe(MIN_FLOAT_SIZE)
    expect(r.h).toBe(1)
  })
})

describe('floatingAfterRemoval', () => {
  it('drops rects whose leaf left the layout', () => {
    const f = floatPane(floatPane([], 'A'), 'Z')
    expect(floatingAfterRemoval(f, tree).map((r) => r.leafId)).toEqual(['A'])
  })
})

describe('hiddenLeafIds', () => {
  it('combines drawered and floating ids for pruning the split view', () => {
    expect(hiddenLeafIds(['A'], floatPane([], 'B'))).toEqual(['A', 'B'])
  })
})

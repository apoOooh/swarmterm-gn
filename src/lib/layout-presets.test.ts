import { describe, it, expect } from 'vitest'
import { collectLeaves, type LayoutNode, type LeafNode, type SplitNode } from './layout-tree'
import { applyPreset, presetsFor, slotRects } from './layout-presets'

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

function ids(tree: LayoutNode): string[] {
  return collectLeaves(tree).map((l) => l.id)
}

function counter(): () => string {
  let n = 0
  return () => `s${++n}`
}

// [A | B] on top, C full-width below.
function threePane(): SplitNode {
  return split('R', 'vertical', [split('T', 'horizontal', [leaf('A'), leaf('B')]), leaf('C')])
}

describe('presetsFor', () => {
  it('offers nothing for a single pane', () => {
    expect(presetsFor(1)).toEqual([])
  })

  it('offers side-by-side and stacked for two panes', () => {
    expect(presetsFor(2).map((p) => p.id)).toEqual(['columns', 'rows'])
  })

  it('adds grid and main-pane presets from three panes up', () => {
    expect(presetsFor(3).map((p) => p.id)).toEqual(['columns', 'rows', 'grid', 'main-left', 'main-top'])
    expect(presetsFor(8).map((p) => p.id)).toEqual(['columns', 'rows', 'grid', 'main-left', 'main-top'])
  })

  it('every preset builds a tree with exactly n slots in input order', () => {
    for (const n of [2, 3, 4, 5, 7, 12]) {
      const leaves = Array.from({ length: n }, (_, i) => leaf(`L${i}`))
      for (const p of presetsFor(n)) {
        expect(ids(p.build(leaves, counter()))).toEqual(leaves.map((l) => l.id))
      }
    }
  })
})

describe('slotRects', () => {
  it('a single leaf fills the unit square', () => {
    expect(slotRects(leaf('A'))).toEqual([{ x: 0, y: 0, w: 1, h: 1 }])
  })

  it('follows split direction and sizes in depth-first order', () => {
    const t = split(
      'R',
      'vertical',
      [split('T', 'horizontal', [leaf('A'), leaf('B')], [25, 75]), leaf('C')],
      [40, 60]
    )
    expect(slotRects(t)).toEqual([
      { x: 0, y: 0, w: 0.25, h: 0.4 },
      { x: 0.25, y: 0, w: 0.75, h: 0.4 },
      { x: 0, y: 0.4, w: 1, h: 0.6 }
    ])
  })
})

describe('applyPreset', () => {
  it('puts the dragged pane in the chosen slot; others keep their order', () => {
    const out = applyPreset(threePane(), [], 'rows', 'A', 2, counter())!
    expect(ids(out)).toEqual(['B', 'C', 'A'])
    expect(slotRects(out).every((r) => r.w === 1)).toBe(true)
  })

  it('switches two side-by-side panes to stacked (dragged to bottom)', () => {
    const two = split('S', 'horizontal', [leaf('A'), leaf('B')])
    expect(applyPreset(two, [], 'rows', 'A', 1, counter())).toEqual(
      split('s1', 'vertical', [leaf('B'), leaf('A')])
    )
  })

  it('keeps drawered leaves in the tree, appended after the visible ones', () => {
    const out = applyPreset(threePane(), ['B'], 'rows', 'C', 0, counter())!
    expect(ids(out)).toEqual(['C', 'A', 'B'])
  })

  it('carries the full leaf node (per-pane overrides) along', () => {
    const rich: LeafNode = { ...leaf('A'), agentId: 'claude', cwd: 'G:/x' }
    const t = split('S', 'horizontal', [rich, leaf('B')])
    const out = applyPreset(t, [], 'rows', 'A', 0, counter())!
    expect(collectLeaves(out)[0]).toBe(rich)
  })

  it('returns null when the request does not fit the current panes', () => {
    const t = threePane()
    expect(applyPreset(t, [], 'nope', 'A', 0, counter())).toBeNull()
    expect(applyPreset(t, [], 'rows', 'Z', 0, counter())).toBeNull()
    expect(applyPreset(t, ['A'], 'rows', 'A', 0, counter())).toBeNull()
    expect(applyPreset(t, [], 'rows', 'A', 3, counter())).toBeNull()
    expect(applyPreset(t, [], 'rows', 'A', -1, counter())).toBeNull()
    // grid is not offered for two visible panes
    expect(applyPreset(t, ['C'], 'grid', 'A', 0, counter())).toBeNull()
  })

  it('never mutates its input', () => {
    const t = threePane()
    const snapshot = JSON.parse(JSON.stringify(t))
    applyPreset(t, [], 'main-left', 'C', 0, counter())
    expect(t).toEqual(snapshot)
  })
})

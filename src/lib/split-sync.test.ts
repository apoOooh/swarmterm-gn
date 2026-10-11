import { describe, it, expect } from 'vitest'
import type { LayoutNode, LeafNode, SplitNode } from './layout-tree'
import { splitsToRealign } from './split-sync'

function leaf(id: string): LeafNode {
  return { type: 'leaf', id, terminalId: `term-${id}` }
}

function split(
  id: string,
  children: [LayoutNode, LayoutNode],
  sizes: [number, number] = [50, 50]
): SplitNode {
  return { type: 'split', id, direction: 'horizontal', sizes, children }
}

describe('splitsToRealign', () => {
  const tree = split('S1', [leaf('A'), split('S2', [leaf('B'), leaf('C')], [50, 50])], [100 / 3, 200 / 3])

  it('is empty when every live group already matches the stored sizes', () => {
    const live = new Map<string, [number, number]>([
      ['S1', [100 / 3, 200 / 3]],
      ['S2', [50, 50]]
    ])
    expect(splitsToRealign(tree, (id) => live.get(id))).toEqual([])
  })

  it('lists a split whose live group still shows the old sizes', () => {
    const live = new Map<string, [number, number]>([
      ['S1', [50, 50]],
      ['S2', [50, 50]]
    ])
    const out = splitsToRealign(tree, (id) => live.get(id))
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('S1')
    expect(out[0].sizes[0]).toBeCloseTo(100 / 3, 6)
  })

  it('skips splits without a mounted group (collapsed, zoomed away, not measured yet)', () => {
    expect(splitsToRealign(tree, () => undefined)).toEqual([])
  })

  it('tolerates sub-pixel differences', () => {
    const live = new Map<string, [number, number]>([['S1', [33.4, 66.6]]])
    expect(splitsToRealign(tree, (id) => live.get(id))).toEqual([])
  })

  it('finds nested splits too', () => {
    const live = new Map<string, [number, number]>([
      ['S1', [100 / 3, 200 / 3]],
      ['S2', [20, 80]]
    ])
    expect(splitsToRealign(tree, (id) => live.get(id)).map((s) => s.id)).toEqual(['S2'])
  })
})

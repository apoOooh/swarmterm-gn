import { describe, expect, it } from 'vitest'
import type { LayoutNode } from '@/lib/layout-tree'
import { toggledZoom, zoomedLeaf } from './pane-zoom'
const leaf = (id: string) => ({ type: 'leaf' as const, id, terminalId: `t-${id}` })
const tree: LayoutNode = { type: 'split', id: 's', direction: 'horizontal', sizes: [50, 50], children: [leaf('a'), leaf('b')] }
describe('pane zoom', () => {
  it('finds the zoomed leaf and lapses for a missing one', () => {
    expect(zoomedLeaf(tree, 'b')?.id).toBe('b')
    expect(zoomedLeaf(tree, 'gone')).toBeNull()
    expect(zoomedLeaf(tree, undefined)).toBeNull()
  })
  it('toggles in and out, and moves to another pane', () => {
    expect(toggledZoom(undefined, 'a')).toBe('a')
    expect(toggledZoom('a', 'a')).toBeUndefined()
    expect(toggledZoom('a', 'b')).toBe('b')
  })
})

import { describe, expect, it } from 'vitest'
import type { LayoutNode } from '@/lib/layout-tree'
import { visibleLayout, drawerAfterRemoval, nextVisibleLeafId } from './pane-drawer'
const leaf = (id: string) => ({ type: 'leaf' as const, id, terminalId: `t-${id}` })
// [a | [b / c]]
const tree: LayoutNode = {
  type: 'split', id: 's1', direction: 'horizontal', sizes: [30, 70],
  children: [leaf('a'), { type: 'split', id: 's2', direction: 'vertical', sizes: [40, 60], children: [leaf('b'), leaf('c')] }]
}
describe('pane drawer', () => {
  it('returns the tree untouched when nothing is drawered', () => {
    expect(visibleLayout(tree, [])).toBe(tree)
  })
  it('prunes a drawered leaf and promotes its sibling, keeping the other split sizes', () => {
    expect(visibleLayout(tree, ['b'])).toEqual({
      type: 'split', id: 's1', direction: 'horizontal', sizes: [30, 70], children: [leaf('a'), leaf('c')]
    })
    expect(visibleLayout(tree, ['a'])).toEqual(tree.type === 'split' ? tree.children[1] : null)
  })
  it('prunes several leaves and returns null once all are drawered', () => {
    expect(visibleLayout(tree, ['a', 'c'])).toEqual(leaf('b'))
    expect(visibleLayout(tree, ['a', 'b', 'c'])).toBeNull()
  })
  it('ignores stale ids', () => {
    expect(visibleLayout(tree, ['gone'])).toEqual(tree)
  })
  it('never mutates the stored tree, so a restore lands in the original slot', () => {
    const before = JSON.stringify(tree)
    visibleLayout(tree, ['b', 'a'])
    expect(JSON.stringify(tree)).toBe(before)
  })
  it('drops drawer ids that left the layout', () => {
    expect(drawerAfterRemoval(['a', 'gone', 'c'], tree)).toEqual(['a', 'c'])
  })
  it('picks the next visible leaf in layout order, wrapping, or undefined', () => {
    expect(nextVisibleLeafId(tree, ['b'], 'b')).toBe('c')
    expect(nextVisibleLeafId(tree, ['c'], 'c')).toBe('a')
    expect(nextVisibleLeafId(tree, ['b', 'c'], 'c')).toBe('a')
    expect(nextVisibleLeafId(tree, ['a', 'b', 'c'], 'a')).toBeUndefined()
  })
})

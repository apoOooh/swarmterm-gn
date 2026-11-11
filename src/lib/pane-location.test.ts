import { describe, expect, it } from 'vitest'
import type { LayoutNode, LeafNode } from '@/lib/layout-tree'
import { locatePane, paneLocationLabel, paneLocationLabels, paneLocations } from '@/lib/pane-location'

const leaf = (id: string): LeafNode => ({ type: 'leaf', id, terminalId: `t-${id}` })
const split = (a: LayoutNode, b: LayoutNode): LayoutNode => ({
  type: 'split', id: `s-${a.id}-${b.id}`, direction: 'horizontal', sizes: [50, 50], children: [a, b]
})

describe('paneLocations', () => {
  it('numbers panes in layout order per workspace', () => {
    const map = paneLocations([
      { name: 'Backend', layout: split(leaf('a'), split(leaf('b'), leaf('c'))) },
      { name: 'Docs', layout: leaf('d') }
    ])
    expect(map.get('t-a')).toEqual({ workspaceName: 'Backend', number: 1 })
    expect(map.get('t-c')).toEqual({ workspaceName: 'Backend', number: 3 })
    expect(map.get('t-d')).toEqual({ workspaceName: 'Docs', number: 1 })
  })

  it('gives drawered panes no number and renumbers the rest, like the navbar', () => {
    const map = paneLocations([
      { name: 'W', layout: split(leaf('a'), split(leaf('b'), leaf('c'))), drawerLeafIds: ['a'] }
    ])
    expect(map.get('t-a')?.number).toBe(0)
    expect(map.get('t-b')?.number).toBe(1)
    expect(map.get('t-c')?.number).toBe(2)
  })

  it('returns null for a terminal that is not open', () => {
    expect(locatePane([{ name: 'W', layout: leaf('a') }], 't-x')).toBeNull()
  })
})

describe('paneLocationLabel', () => {
  it('shows the workspace only when asked', () => {
    expect(paneLocationLabel({ workspaceName: 'Backend', number: 2 }, true)).toBe('Pane 2 · Backend')
    expect(paneLocationLabel({ workspaceName: 'Backend', number: 2 }, false)).toBe('Pane 2')
  })

  it('names a parked pane "Drawer"', () => {
    expect(paneLocationLabel({ workspaceName: 'W', number: 0 }, false)).toBe('Drawer')
  })
})

describe('paneLocationLabels', () => {
  it('adds the workspace only with more than one open', () => {
    expect(paneLocationLabels([{ name: 'W', layout: leaf('a') }])).toEqual({ 't-a': 'Pane 1' })
    expect(
      paneLocationLabels([
        { name: 'W', layout: leaf('a') },
        { name: 'X', layout: leaf('b') }
      ])
    ).toEqual({ 't-a': 'Pane 1 · W', 't-b': 'Pane 1 · X' })
  })
})

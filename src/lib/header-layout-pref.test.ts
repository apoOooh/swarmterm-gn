import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HEADER_LAYOUT,
  HEADER_LAYOUT_STORAGE_KEY,
  moveHeaderItem,
  normalizeHeaderLayout,
  readStoredHeaderLayout,
  storeHeaderLayout,
  toggleHeaderCore,
  applyHeaderLayout
} from './header-layout-pref'
import { OVERFLOW_CHIP_PX, resolveHeaderOverflow } from './header-layout'

const fakeStorage = (initial: Record<string, string> = {}) => {
  const data = { ...initial }
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v } }
}

describe('normalizeHeaderLayout', () => {
  it('falls back to the defaults for garbage', () => {
    expect(normalizeHeaderLayout(null)).toEqual(DEFAULT_HEADER_LAYOUT)
    expect(normalizeHeaderLayout({ order: 5, core: 'x' }).order).toEqual(DEFAULT_HEADER_LAYOUT.order)
  })

  it('drops unknown and duplicate ids', () => {
    const p = normalizeHeaderLayout({ order: ['ctx', 'bogus', 'ctx'], core: ['bogus', 'ctx'] })
    expect(p.order.filter(i => i === 'ctx')).toHaveLength(1)
    expect(p.order).not.toContain('bogus')
    expect(p.core).toEqual(['ctx', 'title'])
  })

  it('re-inserts missing items after their default predecessor', () => {
    const order = DEFAULT_HEADER_LAYOUT.order.filter(i => i !== 'shell').reverse()
    const p = normalizeHeaderLayout({ order, core: [] })
    expect(p.order.indexOf('shell')).toBe(p.order.indexOf('folder') + 1)
    expect(p.order).toHaveLength(DEFAULT_HEADER_LAYOUT.order.length)
  })

  it('always keeps the title core', () => {
    expect(normalizeHeaderLayout({ order: [], core: [] }).core).toEqual(['title'])
  })
})

describe('moveHeaderItem / toggleHeaderCore', () => {
  it('moves an item to the target slot', () => {
    const p = moveHeaderItem(DEFAULT_HEADER_LAYOUT, 'ctx', 'agent')
    expect(p.order.slice(0, 2)).toEqual(['ctx', 'agent'])
  })

  it('toggles core, but never for the title', () => {
    const on = toggleHeaderCore(DEFAULT_HEADER_LAYOUT, 'ctx')
    expect(on.core).toContain('ctx')
    expect(toggleHeaderCore(on, 'ctx').core).not.toContain('ctx')
    expect(toggleHeaderCore(DEFAULT_HEADER_LAYOUT, 'title').core).toContain('title')
  })
})

describe('storage', () => {
  it('round-trips through storage', () => {
    const s = fakeStorage()
    const p = toggleHeaderCore(moveHeaderItem(DEFAULT_HEADER_LAYOUT, 'drawer', 'agent'), 'shell')
    storeHeaderLayout(s, p)
    expect(readStoredHeaderLayout(s)).toEqual(p)
  })

  it('survives corrupted JSON', () => {
    const s = fakeStorage({ [HEADER_LAYOUT_STORAGE_KEY]: '{nope' })
    expect(readStoredHeaderLayout(s)).toEqual(DEFAULT_HEADER_LAYOUT)
  })
})

describe('applyHeaderLayout', () => {
  const items = ['title', 'ctx', 'zoom', 'shell'].map(id => ({ id, width: 40, priority: 99, pinned: id === 'zoom' }))

  it('orders, pins and ranks by the preference; unknown items pass through', () => {
    const pref = toggleHeaderCore(moveHeaderItem(DEFAULT_HEADER_LAYOUT, 'ctx', 'agent'), 'ctx')
    const out = applyHeaderLayout(items, pref)
    expect(out.map(i => i.id)).toEqual(['ctx', 'title', 'shell', 'zoom'])
    expect(out.find(i => i.id === 'ctx')!.pinned).toBe(true)
    expect(out.find(i => i.id === 'shell')!.pinned).toBe(false)
    expect(out.find(i => i.id === 'zoom')!.pinned).toBe(true)
  })

  it('keeps core items visible and hides the last-ordered optional item first', () => {
    const pref = toggleHeaderCore(DEFAULT_HEADER_LAYOUT, 'ctx')
    const out = applyHeaderLayout(items.filter(i => i.id !== 'zoom'), moveHeaderItem(pref, 'shell', 'title'))
    // room for two of three items + the ⋯ chip
    const { visible, hidden } = resolveHeaderOverflow(80 + OVERFLOW_CHIP_PX, out)
    expect(visible).toEqual(['title', 'ctx'])
    expect(hidden).toEqual(['shell'])
  })
})

describe('default hide order', () => {
  it('matches the ranking the header shipped with until the user reorders', () => {
    const ids = ['agent', 'account', 'title', 'folder', 'shell', 'war-room', 'worktree', 'ctx', 'drawer']
    const out = applyHeaderLayout(ids.map(id => ({ id, width: 10, priority: 0, pinned: false })), DEFAULT_HEADER_LAYOUT)
    expect(out.map(i => i.id)).toEqual(ids)
    const hideOrder = out.filter(i => !i.pinned).sort((a, b) => a.priority - b.priority).map(i => i.id)
    expect(hideOrder).toEqual(['shell', 'worktree', 'ctx', 'war-room', 'account', 'drawer'])
  })

  it('new items keep their default core flag only when no core list is stored', () => {
    expect(normalizeHeaderLayout({ order: ['title'] }).core).toEqual(DEFAULT_HEADER_LAYOUT.core)
    expect(normalizeHeaderLayout({ order: ['title'], core: ['title'] }).core).toEqual(['title'])
  })
})

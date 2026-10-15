import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HEADER_LAYOUT,
  HEADER_LAYOUT_STORAGE_KEY,
  moveHeaderItem,
  normalizeHeaderLayout,
  readStoredHeaderLayout,
  storeHeaderLayout,
  setHeaderItemVisibility,
  headerItemVisibility,
  type HeaderItemId,
  type HeaderLayoutPref,
  applyHeaderLayout
} from './header-layout-pref'
import { OVERFLOW_CHIP_PX, resolveHeaderOverflow } from './header-layout'

const toggleHeaderCore = (p: HeaderLayoutPref, id: HeaderItemId): HeaderLayoutPref =>
  setHeaderItemVisibility(p, id, headerItemVisibility(p, id) === 'core' ? 'auto' : 'core')

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

describe('overflow-only and off', () => {
  it('reads a layout saved before these existed unchanged', () => {
    const p = normalizeHeaderLayout({ order: DEFAULT_HEADER_LAYOUT.order, core: ['title', 'ctx'] })
    expect(p.overflow).toEqual([])
    expect(p.off).toEqual([])
    expect(p.core).toEqual(['title', 'ctx'])
  })

  it('keeps the lists disjoint and never lets the title go', () => {
    const p = normalizeHeaderLayout({ order: [], core: ['ctx'], overflow: ['ctx', 'shell', 'title'], off: ['shell', 'drawer'] })
    expect(p.core).toEqual(['ctx', 'title'])
    expect(p.overflow).toEqual(['shell'])
    expect(p.off).toEqual(['drawer'])
    expect(setHeaderItemVisibility(p, 'title', 'off')).toBe(p)
  })

  it('switching visibility moves the id between lists', () => {
    let p = setHeaderItemVisibility(DEFAULT_HEADER_LAYOUT, 'folder', 'overflow')
    expect(headerItemVisibility(p, 'folder')).toBe('overflow')
    expect(p.core).not.toContain('folder')
    p = setHeaderItemVisibility(p, 'folder', 'off')
    expect(p.overflow).toEqual([])
    expect(p.off).toEqual(['folder'])
    p = setHeaderItemVisibility(p, 'folder', 'auto')
    expect(headerItemVisibility(p, 'folder')).toBe('auto')
    const s = fakeStorage()
    storeHeaderLayout(s, setHeaderItemVisibility(p, 'ctx', 'off'))
    expect(readStoredHeaderLayout(s).off).toEqual(['ctx'])
  })

  it('drops off items and never puts overflow-only items in the row, even when wide', () => {
    const items = ['title', 'shell', 'ctx', 'drawer'].map(id => ({ id, width: 30, priority: 0, pinned: false }))
    let p = setHeaderItemVisibility(DEFAULT_HEADER_LAYOUT, 'drawer', 'off')
    p = setHeaderItemVisibility(p, 'shell', 'overflow')
    const out = applyHeaderLayout(items, p)
    expect(out.map(i => i.id)).toEqual(['title', 'shell', 'ctx'])
    expect(resolveHeaderOverflow(2000, out)).toEqual({ visible: ['title', 'ctx'], hidden: ['shell'] })
  })
})

describe('overflow-only edge cases', () => {
  it('an id stored as both core and overflow normalizes to core', () => {
    const p = normalizeHeaderLayout({ order: [], core: ['shell'], overflow: ['shell'] })
    expect(headerItemVisibility(p, 'shell')).toBe('core')
    expect(p.overflow).toEqual([])
  })

  it('all optional items "⋯ only": only core items in the row, hidden in priority order', () => {
    let p = DEFAULT_HEADER_LAYOUT
    for (const id of ['shell', 'ctx', 'drawer'] as HeaderItemId[]) p = setHeaderItemVisibility(p, id, 'overflow')
    const items = ['title', 'drawer', 'ctx', 'shell'].map(id => ({ id, width: 30, priority: 0, pinned: false }))
    expect(resolveHeaderOverflow(5000, applyHeaderLayout(items, p))).toEqual({ visible: ['title'], hidden: ['shell', 'ctx', 'drawer'] })
  })
})

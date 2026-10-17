import { describe, it, expect } from 'vitest'
import { resolveHeaderLevel, resolveHeaderOverflow, shortenPath } from './header-layout'

describe('resolveHeaderLevel', () => {
  it('shows everything at full width', () => {
    expect(resolveHeaderLevel(400, true)).toEqual({
      showFolderPath: true,
      showShellLabel: true,
      worktree: 'full',
    })
  })

  it('truncates the worktree name first as width shrinks', () => {
    const level = resolveHeaderLevel(300, true)
    expect(level.worktree).toBe('name-trunc')
    expect(level.showShellLabel).toBe(true)
    expect(level.showFolderPath).toBe(true)
  })

  it('drops worktree to icon before shedding the shell label', () => {
    const level = resolveHeaderLevel(240, true)
    expect(level.worktree).toBe('icon')
    expect(level.showShellLabel).toBe(true)
    expect(level.showFolderPath).toBe(true)
  })

  it('sheds the shell label before the folder path', () => {
    const level = resolveHeaderLevel(200, true)
    expect(level.showShellLabel).toBe(false)
    expect(level.showFolderPath).toBe(true)
  })

  it('sheds the folder path at the narrowest widths', () => {
    expect(resolveHeaderLevel(150, true).showFolderPath).toBe(false)
  })

  it('never shows a worktree chip when there is no worktree', () => {
    expect(resolveHeaderLevel(400, false).worktree).toBe('hidden')
    expect(resolveHeaderLevel(100, false).worktree).toBe('hidden')
  })
})

describe('shortenPath', () => {
  it('returns the trailing segment of a posix path', () => {
    expect(shortenPath('/home/duong/project')).toBe('project')
  })

  it('returns the trailing segment of a windows path', () => {
    expect(shortenPath('C:\\Project\\2026\\swarmterm')).toBe('swarmterm')
  })

  it('ignores a trailing separator', () => {
    expect(shortenPath('/home/duong/project/')).toBe('project')
  })

  it('returns the input when there is no separator', () => {
    expect(shortenPath('project')).toBe('project')
  })
})

describe('resolveHeaderOverflow', () => {
  const items = [
    { id: 'agent', width: 40, priority: 0, pinned: true },
    { id: 'title', width: 60, priority: 0, pinned: true },
    { id: 'folder', width: 50, priority: 0, pinned: true },
    { id: 'shell', width: 30, priority: 1 },
    { id: 'split-right', width: 24, priority: 2 },
    { id: 'drawer', width: 24, priority: 3 },
    { id: 'close', width: 24, priority: 0, pinned: true },
  ]

  it('hides nothing (and needs no ⋯) when everything fits', () => {
    const r = resolveHeaderOverflow(400, items)
    expect(r.hidden).toEqual([])
    expect(r.visible).toEqual(items.map(i => i.id))
  })

  it('keeps only pinned items in a very narrow pane', () => {
    const r = resolveHeaderOverflow(100, items)
    expect(r.visible).toEqual(['agent', 'title', 'folder', 'close'])
    expect(r.hidden).toEqual(['shell', 'split-right', 'drawer'])
  })

  it('hides lowest-priority items first, reserving room for ⋯', () => {
    // pinned 174 + ⋯ 24 = 198; shell (30) fits in 230, split-right would not.
    const r = resolveHeaderOverflow(230, items)
    expect(r.hidden).toEqual(['split-right', 'drawer'])
    expect(r.visible).toEqual(['agent', 'title', 'folder', 'shell', 'close'])
  })

  it('never lets a smaller low-priority item jump a hidden higher one', () => {
    const r = resolveHeaderOverflow(180, [
      { id: 'a', width: 100, priority: 0, pinned: true },
      { id: 'big', width: 80, priority: 1 },
      { id: 'small', width: 10, priority: 2 },
    ])
    expect(r.hidden).toEqual(['big', 'small'])
  })

  it('treats an exact fit as fitting — no ⋯ reserved', () => {
    const total = items.reduce((n, i) => n + i.width, 0)
    expect(resolveHeaderOverflow(total, items).hidden).toEqual([])
    expect(resolveHeaderOverflow(total - 1, items).hidden.length).toBeGreaterThan(0)
  })

  it('keeps array order among items of equal priority', () => {
    // 60 pinned + 24 ⋯ leaves 31 — room for exactly one of the 30px twins.
    const r = resolveHeaderOverflow(115, [
      { id: 'p', width: 60, priority: 0, pinned: true },
      { id: 'x', width: 30, priority: 1 },
      { id: 'y', width: 30, priority: 1 },
    ])
    expect(r.visible).toEqual(['p', 'x'])
    expect(r.hidden).toEqual(['y'])
  })
})

describe('resolveHeaderOverflow — overflowOnly', () => {
  const it3 = [
    { id: 'title', width: 60, priority: 0, pinned: true },
    { id: 'a', width: 26, priority: 1 },
    { id: 'b', width: 26, priority: 2, overflowOnly: true },
    { id: 'c', width: 26, priority: 3 }
  ]
  it('hides overflow-only items at any width, keeping priority order in hidden', () => {
    expect(resolveHeaderOverflow(5000, it3)).toEqual({ visible: ['title', 'a', 'c'], hidden: ['b'] })
  })
  it('reserves the ⋯ chip for them and still collapses the rest by priority', () => {
    // title + a + chip = 110 fits; c does not.
    expect(resolveHeaderOverflow(115, it3)).toEqual({ visible: ['title', 'a'], hidden: ['b', 'c'] })
  })
  it('a pinned item ignores overflowOnly', () => {
    expect(resolveHeaderOverflow(5000, [{ id: 'x', width: 10, priority: 0, pinned: true, overflowOnly: true }]).visible).toEqual(['x'])
  })
})

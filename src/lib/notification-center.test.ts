import { describe, expect, it } from 'vitest'
import {
  MAX_ENTRIES,
  addEntry,
  clearAll,
  markAllRead,
  markRead,
  markTerminalRead,
  unreadCount,
  type CenterEntry,
  type NewCenterEntry
} from './notification-center'

const e = (over: Partial<NewCenterEntry> = {}): NewCenterEntry => ({
  kind: 'attention',
  terminalId: 't1',
  title: 'Claude Code needs your input',
  detail: 'pane',
  at: 1000,
  ...over
})

describe('addEntry', () => {
  it('prepends a new unread entry with a fresh id', () => {
    const list = addEntry([], e())
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'attention', terminalId: 't1', read: false, at: 1000 })
    expect(list[0].id).toBeTruthy()
    const two = addEntry(list, e({ terminalId: 't2', at: 2000 }))
    expect(two.map((x) => x.terminalId)).toEqual(['t2', 't1'])
    expect(two[0].id).not.toBe(two[1].id)
  })

  it('replaces an unread entry of the same pane and kind instead of stacking', () => {
    const one = addEntry([], e())
    const other = addEntry(one, e({ terminalId: 't2', at: 1500 }))
    const again = addEntry(other, e({ at: 3000, detail: 'renamed' }))
    expect(again).toHaveLength(2)
    expect(again[0]).toMatchObject({ terminalId: 't1', at: 3000, detail: 'renamed', read: false })
  })

  it('keeps a read entry as history and adds a new one', () => {
    const one = markAllRead(addEntry([], e()))
    const again = addEntry(one, e({ at: 3000 }))
    expect(again).toHaveLength(2)
    expect(again.map((x) => x.read)).toEqual([false, true])
  })

  it('is bounded to MAX_ENTRIES, dropping the oldest', () => {
    let list: CenterEntry[] = []
    for (let i = 0; i < MAX_ENTRIES + 5; i++) list = addEntry(list, e({ terminalId: `t${i}`, at: i }))
    expect(list).toHaveLength(MAX_ENTRIES)
    expect(list[list.length - 1].terminalId).toBe('t5')
  })
})

describe('read state', () => {
  const list = addEntry(addEntry(addEntry([], e()), e({ kind: 'exit', at: 2 })), e({ terminalId: 't2' }))

  it('counts unread', () => {
    expect(unreadCount(list)).toBe(3)
    expect(unreadCount(markAllRead(list))).toBe(0)
  })

  it('marks one entry read and leaves the array untouched when nothing changes', () => {
    const id = list[0].id
    const next = markRead(list, id)
    expect(next.find((x) => x.id === id)?.read).toBe(true)
    expect(unreadCount(next)).toBe(2)
    expect(markRead(next, id)).toBe(next)
    expect(markRead(next, 'nope')).toBe(next)
  })

  it('marks every entry of a pane read (the user looked at it)', () => {
    const next = markTerminalRead(list, 't1')
    expect(unreadCount(next)).toBe(1)
    expect(markTerminalRead(next, 't1')).toBe(next)
  })

  it('marks only the given kinds of a pane read when asked', () => {
    const next = markTerminalRead(list, 't1', ['exit'])
    expect(next.filter((x) => !x.read).map((x) => x.kind)).toEqual(['attention', 'attention'])
  })

  it('clears everything', () => {
    expect(clearAll(list)).toEqual([])
  })
})

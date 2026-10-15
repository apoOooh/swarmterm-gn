import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SIDEBAR_PEEK,
  SIDEBAR_PEEK_STORAGE_KEY,
  readStoredSidebarPeek,
  storeSidebarPeek,
  type SidebarPeekStorage
} from './sidebar-peek'

function fakeStorage(initial: Record<string, string> = {}): SidebarPeekStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

describe('sidebar peek setting', () => {
  it('is on by default', () => {
    expect(DEFAULT_SIDEBAR_PEEK).toBe(true)
    expect(readStoredSidebarPeek(fakeStorage())).toBe(true)
  })

  it('reads stored true / false', () => {
    expect(readStoredSidebarPeek(fakeStorage({ [SIDEBAR_PEEK_STORAGE_KEY]: 'false' }))).toBe(false)
    expect(readStoredSidebarPeek(fakeStorage({ [SIDEBAR_PEEK_STORAGE_KEY]: 'true' }))).toBe(true)
  })

  it('falls back to the default for garbage', () => {
    expect(readStoredSidebarPeek(fakeStorage({ [SIDEBAR_PEEK_STORAGE_KEY]: 'yes' }))).toBe(DEFAULT_SIDEBAR_PEEK)
  })

  it('round-trips through storage', () => {
    const s = fakeStorage()
    storeSidebarPeek(s, false)
    expect(s.data[SIDEBAR_PEEK_STORAGE_KEY]).toBe('false')
    expect(readStoredSidebarPeek(s)).toBe(false)
  })
})

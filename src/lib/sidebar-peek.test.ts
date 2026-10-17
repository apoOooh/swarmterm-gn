import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SIDEBAR_PEEK,
  SIDEBAR_PEEK_STORAGE_KEY,
  readStoredSidebarPeek,
  storeSidebarPeek,
  peekCloseDecision,
  DEFAULT_RIGHT_PANEL_PEEK,
  RIGHT_PANEL_PEEK_STORAGE_KEY,
  readStoredRightPanelPeek,
  storeRightPanelPeek,
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

describe('peekCloseDecision', () => {
  it('closes once the pointer is away and nothing floats over it', () => {
    expect(peekCloseDecision({ hovered: false, overlayOpen: false })).toBe('close')
  })
  it('defers while the pointer is back over the sidebar', () => {
    expect(peekCloseDecision({ hovered: true, overlayOpen: false })).toBe('defer')
  })
  it('defers while keyboard focus is inside the panel', () => {
    expect(peekCloseDecision({ hovered: false, overlayOpen: false, focusInside: true })).toBe('defer')
  })
  it('defers while a menu or dialog opened from the sidebar is up', () => {
    expect(peekCloseDecision({ hovered: false, overlayOpen: true })).toBe('defer')
  })
})

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

describe('right panel peek setting', () => {
  it('is on by default and independent of the left setting', () => {
    expect(DEFAULT_RIGHT_PANEL_PEEK).toBe(true)
    expect(readStoredRightPanelPeek(fakeStorage({ [SIDEBAR_PEEK_STORAGE_KEY]: 'false' }))).toBe(true)
  })

  it('round-trips through its own key', () => {
    const s = fakeStorage()
    storeRightPanelPeek(s, false)
    expect(s.data[RIGHT_PANEL_PEEK_STORAGE_KEY]).toBe('false')
    expect(readStoredRightPanelPeek(s)).toBe(false)
    expect(readStoredSidebarPeek(s)).toBe(DEFAULT_SIDEBAR_PEEK)
  })

  it('falls back to the default for garbage', () => {
    expect(readStoredRightPanelPeek(fakeStorage({ [RIGHT_PANEL_PEEK_STORAGE_KEY]: '1' }))).toBe(DEFAULT_RIGHT_PANEL_PEEK)
  })
})

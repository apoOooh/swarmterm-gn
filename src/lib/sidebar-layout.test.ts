import { describe, expect, it } from 'vitest'
import { readSidebarLayout, SIDEBAR_LAYOUT_STORAGE_KEY, storeSidebarLayout } from './sidebar-layout'
const mem = (v: string | null = null) => { let s = v; return { getItem: () => s, setItem: (_k: string, x: string) => { s = x } } }
describe('sidebar layout pref', () => {
  it('defaults to auto and ignores junk', () => {
    expect(readSidebarLayout(mem())).toBe('auto')
    expect(readSidebarLayout(mem('sideways'))).toBe('auto')
  })
  it('round-trips manual', () => {
    const m = mem(); storeSidebarLayout(m, 'manual')
    expect(readSidebarLayout(m)).toBe('manual')
    expect(SIDEBAR_LAYOUT_STORAGE_KEY).toBe('swarmterm-sidebar-layout')
  })
})

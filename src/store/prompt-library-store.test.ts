import { beforeEach, describe, expect, it, vi } from 'vitest'

// Vitest runs in node: a Map-backed stand-in for the webview's localStorage.
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  clear: () => mem.clear()
})
import { usePromptLibraryStore } from './prompt-library-store'

describe('prompt-library-store', () => {
  beforeEach(() => {
    localStorage.clear()
    usePromptLibraryStore.setState({ prompts: [], error: null, open: false })
  })

  it('saves to local storage and hydrates back', () => {
    expect(usePromptLibraryStore.getState().save({ id: 'a', title: 'Review', body: 'Check it', updatedAt: 1 })).toBe(true)
    usePromptLibraryStore.setState({ prompts: [] })
    usePromptLibraryStore.getState().hydrate()
    expect(usePromptLibraryStore.getState().prompts.map((p) => p.title)).toEqual(['Review'])
  })

  it('reports invalid prompts without saving', () => {
    expect(usePromptLibraryStore.getState().save({ id: 'a', title: '', body: 'x', updatedAt: 1 })).toBe(false)
    expect(usePromptLibraryStore.getState().error).toMatch(/title/i)
    expect(localStorage.getItem('swarmterm-prompts-v1')).toBeNull()
  })

  it('removes', () => {
    const s = usePromptLibraryStore.getState()
    s.save({ id: 'a', title: 'A', body: 'x', updatedAt: 1 })
    s.remove('a')
    expect(usePromptLibraryStore.getState().prompts).toEqual([])
  })
})

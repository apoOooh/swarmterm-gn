import { describe, expect, it } from 'vitest'
import { DEFAULT_MARKDOWN_PREFS, MARKDOWN_PREF_STORAGE_KEY, isMarkdownPath, readStoredMarkdownPrefs, storeMarkdownPrefs } from './markdown-pref'

function storage(initial: string | null = null) {
  const data = new Map<string, string>()
  if (initial !== null) data.set(MARKDOWN_PREF_STORAGE_KEY, initial)
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}

describe('markdown prefs', () => {
  it('defaults to the rendered view with auto-detected MarkText', () => {
    expect(readStoredMarkdownPrefs(storage())).toEqual({ defaultMode: 'preview', marktextPath: '' })
  })
  it('falls back on corrupt JSON or non-objects', () => {
    expect(readStoredMarkdownPrefs(storage('{oops'))).toBe(DEFAULT_MARKDOWN_PREFS)
    expect(readStoredMarkdownPrefs(storage('42'))).toBe(DEFAULT_MARKDOWN_PREFS)
  })
  it('keeps valid fields when another one is invalid', () => {
    expect(readStoredMarkdownPrefs(storage(JSON.stringify({ defaultMode: 'raw', marktextPath: ' C:/MarkText/marktext.exe ' }))))
      .toEqual({ defaultMode: 'preview', marktextPath: 'C:/MarkText/marktext.exe' })
    expect(readStoredMarkdownPrefs(storage(JSON.stringify({ defaultMode: 'split', marktextPath: 7 }))))
      .toEqual({ defaultMode: 'split', marktextPath: '' })
  })
  it('round-trips through storage', () => {
    const s = storage()
    storeMarkdownPrefs(s, { defaultMode: 'editor', marktextPath: 'D:/x/marktext.exe' })
    expect(readStoredMarkdownPrefs(s)).toEqual({ defaultMode: 'editor', marktextPath: 'D:/x/marktext.exe' })
  })
  it('recognises Markdown extensions case-insensitively', () => {
    expect(isMarkdownPath('/p/README.md')).toBe(true)
    expect(isMarkdownPath('/p/notes.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('/p/md.txt')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  FAVORITES_STORAGE_KEY, readFavorites, storeFavorites, toggleFavorite, quickAccess,
  filterFolders, splitTypedPath, samePath, MAX_QUICK_RECENTS
} from './folder-picker'

const mem = (init: Record<string, string> = {}) => {
  const data = { ...init }
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v } }
}

describe('favorites persistence', () => {
  it('reads an empty list for missing or malformed data', () => {
    expect(readFavorites(mem())).toEqual([])
    expect(readFavorites(mem({ [FAVORITES_STORAGE_KEY]: '{' }))).toEqual([])
    expect(readFavorites(mem({ [FAVORITES_STORAGE_KEY]: '{"a":1}' }))).toEqual([])
  })
  it('drops non-strings and blanks on read, round-trips through store', () => {
    const s = mem({ [FAVORITES_STORAGE_KEY]: JSON.stringify(['C:\\a', 3, ' ', 'D:\\b']) })
    expect(readFavorites(s)).toEqual(['C:\\a', 'D:\\b'])
    storeFavorites(s, ['X:\\y'])
    expect(readFavorites(s)).toEqual(['X:\\y'])
  })
})

describe('toggleFavorite', () => {
  it('adds to the end and removes case/slash-insensitively', () => {
    expect(toggleFavorite(['C:\\a'], 'D:\\b')).toEqual(['C:\\a', 'D:\\b'])
    expect(toggleFavorite(['C:\\a', 'D:\\b'], 'c:/a/')).toEqual(['D:\\b'])
    expect(toggleFavorite(['C:\\a'], '  ')).toEqual(['C:\\a'])
  })
})

describe('samePath', () => {
  it('ignores case, separators and trailing slashes', () => {
    expect(samePath('C:\\Code\\x\\', 'c:/code/x')).toBe(true)
    expect(samePath('C:\\Code\\x', 'C:\\Code\\y')).toBe(false)
  })
})

describe('quickAccess', () => {
  it('merges recents and saved workspace folders, skipping favorites and duplicates', () => {
    const r = quickAccess(['C:\\fav'], ['C:\\a', 'c:/fav'], [{ cwd: 'C:\\A\\' }, { cwd: 'D:\\w' }])
    expect(r).toEqual({ favorites: ['C:\\fav'], recents: ['C:\\a', 'D:\\w'] })
  })
  it('caps recents', () => {
    const many = Array.from({ length: 30 }, (_, i) => `C:\\r${i}`)
    expect(quickAccess([], many, []).recents).toHaveLength(MAX_QUICK_RECENTS)
  })
})

describe('filterFolders', () => {
  const list = ['C:\\Code\\alpha', 'C:\\Code\\Beta', 'C:\\Code\\alphabet']
  it('returns all on empty query', () => expect(filterFolders(list, ' ')).toEqual(list))
  it('matches the folder name, prefix hits first', () => {
    expect(filterFolders(list, 'bet')).toEqual(['C:\\Code\\Beta', 'C:\\Code\\alphabet'])
    expect(filterFolders(list, 'code')).toEqual([])
  })
})

describe('splitTypedPath', () => {
  it('treats input ending in a separator as a folder to open', () => {
    expect(splitTypedPath('C:\\Code\\')).toEqual({ dir: 'C:\\Code\\', filter: '' })
    expect(splitTypedPath('/home/')).toEqual({ dir: '/home/', filter: '' })
  })
  it('splits an absolute path into parent folder and name filter', () => {
    expect(splitTypedPath('C:\\Code\\sw')).toEqual({ dir: 'C:\\Code\\', filter: 'sw' })
    expect(splitTypedPath('D:')).toEqual({ dir: 'D:\\', filter: '' })
  })
  it('leaves plain text as a filter on the current folder', () => {
    expect(splitTypedPath('swarm')).toEqual({ dir: null, filter: 'swarm' })
  })
})

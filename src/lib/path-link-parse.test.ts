import { describe, expect, it } from 'vitest'
import { absoluteWindowsPath, detectPathCandidates, isRelativePath, listingDirAbove, listingEntry, parsePathSuffix, relativeBases } from './path-link-parse'

describe('parsePathSuffix', () => {
  it('parses line and column', () => {
    expect(parsePathSuffix('src/foo.ts:42:9')).toEqual({ path: 'src/foo.ts', line: 42, col: 9 })
  })

  it('parses line only', () => {
    expect(parsePathSuffix('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42 })
  })

  it('parses the MSVC/tsc parenthesised form', () => {
    expect(parsePathSuffix('src/foo.ts(42,9)')).toEqual({ path: 'src/foo.ts', line: 42, col: 9 })
    expect(parsePathSuffix('src/foo.ts(42)')).toEqual({ path: 'src/foo.ts', line: 42 })
  })

  it('parses the Python traceback form', () => {
    expect(parsePathSuffix('File "src/foo.py", line 42')).toEqual({ path: 'src/foo.py', line: 42 })
  })

  it('keeps a Windows drive letter out of the line number', () => {
    expect(parsePathSuffix('C:\\src\\foo.ts:42')).toEqual({ path: 'C:\\src\\foo.ts', line: 42 })
    expect(parsePathSuffix('C:\\src\\foo.ts')).toEqual({ path: 'C:\\src\\foo.ts' })
  })

  it('returns the whole text when there is no suffix', () => {
    expect(parsePathSuffix('src/foo.ts')).toEqual({ path: 'src/foo.ts' })
  })
})

describe('detectPathCandidates', () => {
  it('finds a relative path with its suffix', () => {
    expect(detectPathCandidates('  at src/lib/foo.ts:42:9 in handler')).toEqual([
      { text: 'src/lib/foo.ts:42:9', start: 5, end: 24 },
    ])
  })

  it('finds an absolute posix path', () => {
    const out = detectPathCandidates('wrote /Users/me/app/src/index.ts')
    expect(out).toEqual([{ text: '/Users/me/app/src/index.ts', start: 6, end: 32 }])
  })

  it('finds a Windows path', () => {
    const out = detectPathCandidates('open C:\\Users\\me\\app\\main.rs')
    expect(out).toEqual([{ text: 'C:\\Users\\me\\app\\main.rs', start: 5, end: 28 }])
  })

  it('strips trailing sentence punctuation', () => {
    expect(detectPathCandidates('see src/foo.ts.')).toEqual([
      { text: 'src/foo.ts', start: 4, end: 14 },
    ])
  })

  it('ignores a bare word with no separator', () => {
    expect(detectPathCandidates('foo.ts is fine')).toEqual([])
  })

  it('ignores a URL so WebLinksAddon owns it', () => {
    expect(detectPathCandidates('see https://example.com/a/b')).toEqual([])
  })

  it('returns nothing for a line past the length limit', () => {
    expect(detectPathCandidates('a/b.ts '.repeat(400))).toEqual([])
  })

  it('caps the number of candidates per line', () => {
    const line = Array.from({ length: 20 }, (_, i) => `s/f${i}.ts`).join(' ')
    expect(detectPathCandidates(line)).toHaveLength(10)
  })
})

describe('listingEntry', () => {
  it('takes the Name column of a file row, with spaces', () => {
    expect(listingEntry('-a----        10.10.2026     22:25            437 logo.svg')).toEqual({ text: 'logo.svg', start: 50, end: 58, dir: false })
    expect(listingEntry('-a----        10.10.2026     22:25             21 my notes.txt')?.text).toBe('my notes.txt')
  })
  it('marks folder rows and ignores headers and prose', () => {
    expect(listingEntry('d-----        10.10.2026     22:25                assets')).toMatchObject({ text: 'assets', dir: true })
    expect(listingEntry('d-----        10.10.2026     22:25                mit leerzeichen')?.text).toBe('mit leerzeichen')
    expect(listingEntry('Mode                 LastWriteTime         Length Name')).toBeNull()
    expect(listingEntry('see logo.svg')).toBeNull()
  })
})
describe('listingDirAbove', () => {
  it('finds the PowerShell listing header above an entry', () => {
    const above = ['', 'Mode                 LastWriteTime         Length Name', '', '    Verzeichnis: D:\\p\\assets', '']
    expect(listingDirAbove(above)).toBe('D:\\p\\assets')
    expect(listingDirAbove(['    Directory: C:\\Users\\me'])).toBe('C:\\Users\\me')
  })
  it('stops at the prompt of an earlier command', () => {
    expect(listingDirAbove(['PS D:\\p> dir', '    Verzeichnis: D:\\old'])).toBeNull()
    expect(listingDirAbove(['nothing here'])).toBeNull()
  })
})

describe('isRelativePath', () => {
  it('is true only for paths without a drive or a leading separator', () => {
    expect(isRelativePath('out/shot.png')).toBe(true)
    expect(isRelativePath('..\\x\\y.md')).toBe(true)
    expect(isRelativePath('D:\\x\\y.md')).toBe(false)
    expect(isRelativePath('/d/x/y.md')).toBe(false)
    expect(isRelativePath('\\x\\y.md')).toBe(false)
  })
})

describe('absoluteWindowsPath', () => {
  it('keeps drive paths and maps Git Bash /d/… paths to D:\\…', () => {
    expect(absoluteWindowsPath('D:\\swarmterm-testlab')).toBe('D:\\swarmterm-testlab')
    expect(absoluteWindowsPath('d:/lab/run.mjs')).toBe('d:/lab/run.mjs')
    expect(absoluteWindowsPath('/d/swarmterm-testlab/out')).toBe('D:\\swarmterm-testlab\\out')
  })
  it('refuses relative and plain posix paths', () => {
    expect(absoluteWindowsPath('out/x.png')).toBeNull()
    expect(absoluteWindowsPath('/usr/lib/x')).toBeNull()
  })
})

describe('relativeBases', () => {
  it('takes absolute paths of the same line, then the lines above, nearest line leading', () => {
    const bases = relativeBases('Saved in D:\\lab: out/30-fail.png', ['cd /d/far/dir', 'older D:\\old\\notes.md'])
    expect(bases).toEqual(['D:\\lab', 'D:\\far\\dir', 'D:\\far', 'D:\\old\\notes.md', 'D:\\old'])
  })
  it('offers a file path and its folder, strips the line suffix and drops duplicates', () => {
    expect(relativeBases('', ['at D:\\lab\\run.mjs:12:3', 'D:\\LAB\\run.mjs'])).toEqual(['D:\\lab\\run.mjs', 'D:\\lab'])
  })
  it('skips relative paths and stops after the source cap', () => {
    expect(relativeBases('src/a.ts', ['lib/b.ts'])).toEqual([])
    const above = ['C:\\a\\x', 'C:\\b\\x', 'C:\\c\\x', 'C:\\d\\x']
    expect(relativeBases('', above, { maxSources: 2 })).toEqual(['C:\\a\\x', 'C:\\a', 'C:\\b\\x', 'C:\\b'])
  })
  it('reads a single-segment folder and ignores URLs', () => {
    expect(relativeBases('', ['cd D:\\swarmterm-testlab && node run.mjs'])).toEqual(['D:\\swarmterm-testlab'])
    expect(relativeBases('see https://example.com/a/b', [])).toEqual([])
  })
  it('leaves out the bases the caller already tried', () => {
    expect(relativeBases('D:\\GN_AI\\swarmterm out/x.png', [], { exclude: ['d:\\gn_ai\\swarmterm'] })).toEqual(['D:\\GN_AI'])
  })
})

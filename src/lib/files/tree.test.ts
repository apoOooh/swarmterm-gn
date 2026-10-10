import { describe, expect, it } from 'vitest'
import { fileKind, gitBadge, treeRows, virtualRange } from './tree'
import { fileRun } from './run'
const entry = (path: string, isDir = false) => ({ path, name: path.split('/').pop()!, isDir, isSymlink: false })
describe('explorer rows', () => {
  it('keeps expanded rows in selection order and bounds DOM work on large directories', () => {
    const rows = treeRows('/p', { '/p': { entries: [entry('/p/src', true), entry('/p/z')] }, '/p/src': { entries: [entry('/p/src/a')] } }, new Set(['/p/src']))
    expect(rows.map((r) => r.entry.path)).toEqual(['/p/src', '/p/src/a', '/p/z'])
    const range = virtualRange(100_000, 1000, 400, 24)
    expect(range.end - range.start).toBeLessThan(40)
  })
  it('propagates git decoration to ancestors and keeps SVG in the editor', () => {
    expect(gitBadge('/p/src', { '/p/src/a': 'M', '/p/src/b': '?' })).toBe('M')
    expect(fileKind('icon.svg')).toBe('text'); expect(fileKind('clip.webm')).toBe('video')
  })
  it('bounds directory-link cycles without dropping adjacent files', () => {
    const loop = { ...entry('/p/loop', true), isSymlink: true }
    const rows = treeRows('/p', { '/p': { entries: [loop, entry('/p/a')] }, '/p/loop': { entries: [loop, entry('/p/loop/b')] } }, new Set(['/p/loop']))
    expect(rows.map((r) => r.entry.path)).toEqual(['/p/loop', '/p/loop/b', '/p/a'])
  })
})
describe('file runners', () => {
  it('selects Astera runners and quotes paths for the pane shell', () => {
    expect(fileRun("/p/don't.py", 'posix')?.command).toBe("python '/p/don'\\''t.py'")
    expect(fileRun('C:\\a b\\test_example.py', 'powershell')?.command).toBe("python -m pytest 'C:\\a b\\test_example.py'")
    expect(fileRun('compose.override.yaml', 'posix')?.label).toBe('Compose up')
    expect(fileRun('x.ts', 'posix')).toBeNull(); expect(fileRun('a%PATH%.js', 'cmd')).toBeNull()
    expect(fileRun('a\nrm.py', 'posix')).toBeNull()
  })
})

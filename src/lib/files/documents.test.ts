import { describe, expect, it } from 'vitest'
import { diskChanged, editDocument, newDocument, serializedDocument } from './documents'
const context = { id: 'root', root: '/p' }
const disk = (content: string, version = 'v1') => ({ content, version, binary: false, truncated: false, bom: false })
describe('document lifecycle', () => {
  it('preserves CRLF when editing and treats normalized buffers as clean', () => {
    const doc = newDocument(context, '/p/a.txt', disk('a\r\nb\r\n'))
    expect(editDocument(doc, 'a\nb\n').dirty).toBe(false)
    expect(serializedDocument(editDocument(doc, 'a\nchanged\n'))).toBe('a\r\nchanged\r\n')
  })
  it('reloads clean files but protects a dirty buffer from external edits', () => {
    const doc = newDocument(context, '/p/a.txt', disk('old'))
    expect(diskChanged(doc, disk('new', 'v2')).content).toBe('new')
    const conflict = diskChanged(editDocument(doc, 'mine'), disk('theirs', 'v2'))
    expect(conflict.content).toBe('mine'); expect(conflict.conflict?.content).toBe('theirs')
    expect(diskChanged(editDocument(doc, 'mine'), disk('old')).conflict).toBeUndefined()
  })
  it('makes binary and truncated files read only', () => {
    expect(newDocument(context, '/p/a', { ...disk(''), binary: true }).readOnly).toBe(true)
    expect(newDocument(context, '/p/a', { ...disk(''), truncated: true }).readOnly).toBe(true)
  })
})

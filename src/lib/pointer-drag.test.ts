import { describe, expect, it } from 'vitest'
import { canDropInto, dragCursor, dragEffect, dragLabel, dropDirectory, pastThreshold } from './pointer-drag'
describe('explorer pointer drag', () => {
  it('starts only after the threshold', () => {
    expect(pastThreshold({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false)
    expect(pastThreshold({ x: 0, y: 0 }, { x: 4, y: 4 })).toBe(true)
  })
  it('maps targets to effects and cursors', () => {
    expect(dragEffect('pane', false)).toBe('copy')
    expect(dragEffect('dir', false)).toBe('move')
    expect(dragEffect('dir', true)).toBe('copy')
    expect(dragEffect('none', true)).toBe('none')
    expect(dragCursor('none')).toBe('no-drop')
    expect(dragCursor('copy')).toBe('copy')
  })
  it('labels one or many paths', () => {
    expect(dragLabel(['C:\\p\\a.png'])).toBe('a.png')
    expect(dragLabel(['/p/a.png', '/p/b', '/p/c'])).toBe('a.png +2')
    expect(dragLabel([])).toBe('')
  })
  it('resolves the drop folder and refuses moving a folder into itself', () => {
    expect(dropDirectory({ path: '/p/src', isDir: true, parent: '/p' })).toBe('/p/src')
    expect(dropDirectory({ path: '/p/a.ts', isDir: false, parent: '/p' })).toBe('/p')
    expect(canDropInto('C:\\p\\src\\lib', ['C:\\p\\src'])).toBe(false)
    expect(canDropInto('C:\\p\\src', ['C:\\p\\src'])).toBe(false)
    expect(canDropInto('C:\\p\\srcx', ['C:\\p\\src'])).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  PANE_COLORS,
  hasPaneIdentity,
  sanitizePaneColor,
  sanitizePaneIcon,
  sanitizePaneIdentity
} from './pane-identity'

describe('sanitizePaneIcon', () => {
  it('keeps curated icon ids', () => {
    expect(sanitizePaneIcon('bug')).toBe('bug')
    expect(sanitizePaneIcon(' git-branch ')).toBe('git-branch')
  })

  it('keeps a single emoji, including ZWJ sequences', () => {
    expect(sanitizePaneIcon('🔍')).toBe('🔍')
    expect(sanitizePaneIcon('🧑‍💻')).toBe('🧑‍💻')
  })

  it('rejects text, digits, unknown ids and blanks', () => {
    expect(sanitizePaneIcon('reviewer')).toBeUndefined()
    expect(sanitizePaneIcon('🔍 a')).toBeUndefined()
    expect(sanitizePaneIcon('1')).toBeUndefined()
    expect(sanitizePaneIcon('   ')).toBeUndefined()
    expect(sanitizePaneIcon(undefined)).toBeUndefined()
    expect(sanitizePaneIcon('🔍'.repeat(10))).toBeUndefined()
  })
})

describe('sanitizePaneColor', () => {
  it('accepts palette colors case-insensitively and rejects others', () => {
    expect(sanitizePaneColor(PANE_COLORS[0].toUpperCase())).toBe(PANE_COLORS[0])
    expect(sanitizePaneColor('#123456')).toBeUndefined()
    expect(sanitizePaneColor('red')).toBeUndefined()
  })
})

describe('sanitizePaneIdentity', () => {
  it('cleans each field independently and keeps name case', () => {
    expect(sanitizePaneIdentity({ name: '  Reviewer  ', icon: 'nope', color: PANE_COLORS[1] })).toEqual({
      name: 'Reviewer',
      icon: undefined,
      color: PANE_COLORS[1]
    })
  })

  it('clears a numeric name (would shadow the pane number)', () => {
    expect(sanitizePaneIdentity({ name: '3' }).name).toBeUndefined()
  })
})

describe('hasPaneIdentity', () => {
  it('is true with a name or an icon, not with a color alone', () => {
    expect(hasPaneIdentity({ name: 'A' })).toBe(true)
    expect(hasPaneIdentity({ icon: 'bug' })).toBe(true)
    expect(hasPaneIdentity({ color: PANE_COLORS[0] })).toBe(false)
  })
})

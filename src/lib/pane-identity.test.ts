import { describe, expect, it } from 'vitest'
import {
  PANE_COLORS,
  sanitizePaneColor,
  isEmojiIcon,
  paneHeaderTintStyle,
  searchIconNames,
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

  it('keeps any lucide-shaped icon name (existence is checked at render)', () => {
    expect(sanitizePaneIcon('arrow-big-up')).toBe('arrow-big-up')
    expect(sanitizePaneIcon('circle-dot-2')).toBe('circle-dot-2')
  })

  it('rejects mixed text, digits, odd shapes and blanks', () => {
    expect(sanitizePaneIcon('Reviewer')).toBeUndefined()
    expect(sanitizePaneIcon('two words')).toBeUndefined()
    expect(sanitizePaneIcon('-bug')).toBeUndefined()
    expect(sanitizePaneIcon('a'.repeat(49))).toBeUndefined()
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
    expect(sanitizePaneIdentity({ name: '  Reviewer  ', icon: 'Not An Icon', color: PANE_COLORS[1] })).toEqual({
      name: 'Reviewer',
      icon: undefined,
      color: PANE_COLORS[1],
      headerTint: undefined
    })
  })

  it('clears a numeric name (would shadow the pane number)', () => {
    expect(sanitizePaneIdentity({ name: '3' }).name).toBeUndefined()
  })

  it('keeps the header tint only together with a valid color', () => {
    expect(sanitizePaneIdentity({ color: PANE_COLORS[0], headerTint: true }).headerTint).toBe(true)
    expect(sanitizePaneIdentity({ headerTint: true }).headerTint).toBeUndefined()
    expect(sanitizePaneIdentity({ color: 'red', headerTint: true }).headerTint).toBeUndefined()
    expect(sanitizePaneIdentity({ color: PANE_COLORS[0], headerTint: false }).headerTint).toBeUndefined()
  })
})

describe('isEmojiIcon', () => {
  it('tells emoji apart from icon names', () => {
    expect(isEmojiIcon('🔍')).toBe(true)
    expect(isEmojiIcon('bug')).toBe(false)
    expect(isEmojiIcon('nope nope')).toBe(false)
    expect(isEmojiIcon(undefined)).toBe(false)
  })
})

describe('searchIconNames', () => {
  const names = ['bug', 'bug-off', 'ladybug', 'arrow-big-up', 'arrow-up', 'rocket']

  it('ranks exact, then prefix, then substring matches', () => {
    expect(searchIconNames(names, 'bug', 10)).toEqual(['bug', 'bug-off', 'ladybug'])
  })

  it('needs every word and accepts spaces or dashes', () => {
    expect(searchIconNames(names, 'arrow up', 10)).toEqual(['arrow-up', 'arrow-big-up'])
    expect(searchIconNames(names, 'Arrow-Big', 10)).toEqual(['arrow-big-up'])
  })

  it('caps the result and returns nothing for a blank query', () => {
    expect(searchIconNames(names, 'u', 2)).toHaveLength(2)
    expect(searchIconNames(names, '  ', 10)).toEqual([])
  })
})

describe('PANE_COLORS', () => {
  it('has 20 distinct lowercase hex colors without the execute orange', () => {
    expect(PANE_COLORS).toHaveLength(20)
    expect(new Set(PANE_COLORS).size).toBe(20)
    expect(PANE_COLORS.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
    expect(PANE_COLORS).not.toContain('#f97316')
  })
})

describe('paneHeaderTintStyle', () => {
  it('tints background and bottom border with the identity color', () => {
    expect(paneHeaderTintStyle(PANE_COLORS[0], true)).toEqual({
      backgroundColor: `${PANE_COLORS[0]}2e`,
      borderBottomColor: PANE_COLORS[0]
    })
  })

  it('leaves the border to the zoom marker on a zoomed pane', () => {
    expect(paneHeaderTintStyle(PANE_COLORS[0], true, true)).toEqual({ backgroundColor: `${PANE_COLORS[0]}2e` })
  })

  it('is undefined without tint or without a palette color', () => {
    expect(paneHeaderTintStyle(PANE_COLORS[0], undefined)).toBeUndefined()
    expect(paneHeaderTintStyle(undefined, true)).toBeUndefined()
    expect(paneHeaderTintStyle('#123456', true)).toBeUndefined()
  })
})

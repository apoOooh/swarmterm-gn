import { describe, expect, it } from 'vitest'
import {
  PANE_COLORS,
  sanitizePaneColor,
  paneHeaderTintStyle,
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

  it('keeps the header tint only together with a valid color', () => {
    expect(sanitizePaneIdentity({ color: PANE_COLORS[0], headerTint: true }).headerTint).toBe(true)
    expect(sanitizePaneIdentity({ headerTint: true }).headerTint).toBeUndefined()
    expect(sanitizePaneIdentity({ color: 'red', headerTint: true }).headerTint).toBeUndefined()
    expect(sanitizePaneIdentity({ color: PANE_COLORS[0], headerTint: false }).headerTint).toBeUndefined()
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

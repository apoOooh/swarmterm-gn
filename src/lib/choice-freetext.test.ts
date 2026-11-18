import { describe, expect, it } from 'vitest'
import { choiceFreeTextActive, choiceFreeTextFilled } from './choice-freetext'

const dialog = (selected: number) =>
  [
    '────────────────────────────',
    ' ☐ Auth',
    '',
    'Which approach?',
    '',
    `${selected === 1 ? '❯' : ' '} 1. JWT`,
    '     Stateless tokens',
    `${selected === 2 ? '❯' : ' '} 2. Session`,
    `${selected === 3 ? '❯' : ' '} 3. Type something.`,
    '────────────────────────────',
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel'
  ]

describe('choiceFreeTextActive', () => {
  it('is true when the empty free-text row is selected', () => {
    expect(choiceFreeTextActive(dialog(3))).toBe(true)
  })

  it('is false when an ordinary option is selected', () => {
    expect(choiceFreeTextActive(dialog(1))).toBe(false)
    expect(choiceFreeTextActive(dialog(2))).toBe(false)
  })

  it('is false on a permission prompt, whatever is selected', () => {
    const rows = [
      'Bash command',
      'Do you want to proceed?',
      '❯ 1. Type something odd',
      '  2. No',
      'Enter to select · Esc to cancel'
    ]
    expect(choiceFreeTextActive(rows)).toBe(false)
  })

  it('is false on approval phrasing such as "Would you like to proceed?"', () => {
    expect(choiceFreeTextActive(['Would you like to proceed?', ...dialog(3)])).toBe(false)
    expect(choiceFreeTextActive(['Do you want to make this edit?', ...dialog(3)])).toBe(false)
  })

  it('is false without the select footer', () => {
    expect(choiceFreeTextActive(dialog(3).slice(0, -1))).toBe(false)
  })

  it('is false when the field already holds text (no guessing)', () => {
    const rows = dialog(3).map((r) => r.replace('Type something.', 'my answer'))
    expect(choiceFreeTextActive(rows)).toBe(false)
  })

  it('is false for an ambiguous screen with two highlighted rows', () => {
    const rows = [...dialog(3), '❯ 1. Old']
    expect(choiceFreeTextActive(rows)).toBe(false)
  })

  describe('with the hook-reported dialog shape (SWA-107)', () => {
    const one = [{ options: 2, multiSelect: false }]
    const filled = (text: string) => dialog(3).map((r) => r.replace('Type something.', text))

    it('accepts the free-text row by number, filled or empty', () => {
      expect(choiceFreeTextActive(dialog(3), one)).toBe(true)
      expect(choiceFreeTextActive(filled('erstes diktat'), one)).toBe(true)
    })

    it('accepts a long answer that wraps over several rows', () => {
      const rows = filled('erstes diktat ' + 'lang '.repeat(40))
      const i = rows.findIndex((r) => r.startsWith('❯ 3.'))
      rows.splice(i + 1, 0, '     lang lang lang lang lang lang')
      expect(choiceFreeTextActive(rows, one)).toBe(true)
    })

    it('refuses an ordinary option, also one whose label looks like free text', () => {
      expect(choiceFreeTextActive(dialog(1), one)).toBe(false)
      expect(choiceFreeTextActive(dialog(2).map((r) => r.replace('2. Session', '2. Type something')), one)).toBe(false)
    })

    it('refuses "Chat about this" and numbers past the free-text row', () => {
      const rows = dialog(3).map((r) => r.replace('❯ 3.', '  3.').replace('  4. Chat', '❯ 4. Chat'))
      expect(choiceFreeTextActive(rows, one)).toBe(false)
    })

    it('refuses a number that is an ordinary option of another question', () => {
      expect(choiceFreeTextActive(dialog(3), [...one, { options: 3, multiSelect: false }])).toBe(false)
      expect(choiceFreeTextActive(dialog(3), [...one, { options: 2, multiSelect: false }])).toBe(true)
    })

    it('refuses multi-select dialogs', () => {
      expect(choiceFreeTextActive(dialog(3), [{ options: 2, multiSelect: true }])).toBe(false)
    })

    it('keeps the permission veto, footer and single-highlight checks', () => {
      expect(choiceFreeTextActive(['Do you want to proceed?', ...dialog(3)], one)).toBe(false)
      expect(choiceFreeTextActive(dialog(3).slice(0, -1), one)).toBe(false)
      expect(choiceFreeTextActive([...dialog(3), '❯ 1. Old'], one)).toBe(false)
    })

    it('falls back to the empty-field rule without a shape', () => {
      expect(choiceFreeTextActive(filled('x'), [])).toBe(false)
      expect(choiceFreeTextActive(filled('x'))).toBe(false)
    })
  })

  describe('choiceFreeTextFilled', () => {
    it('is false for the placeholder and true once the row holds text', () => {
      expect(choiceFreeTextFilled(dialog(3))).toBe(false)
      expect(choiceFreeTextFilled(dialog(3).map((r) => r.replace('Type something.', 'erstes')))).toBe(true)
      expect(choiceFreeTextFilled([...dialog(3), '❯ 1. Old'])).toBe(false)
    })
  })
})

import { describe, expect, it } from 'vitest'
import { choiceFreeTextActive } from './choice-freetext'

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
})

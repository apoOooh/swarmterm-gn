import { describe, expect, it } from 'vitest'
import { parseAnsi } from './ansi-preview'

describe('parseAnsi', () => {
  it('returns plain text as one uncoloured span', () => {
    expect(parseAnsi('mcp ✓')).toEqual([{ text: 'mcp ✓' }])
  })

  it('maps truecolor foreground and resets', () => {
    expect(parseAnsi('\x1b[38;2;16;32;48mab\x1b[0m c')).toEqual([
      { text: 'ab', color: 'rgb(16, 32, 48)' },
      { text: ' c' }
    ])
  })

  it('maps the 16 basic colours to theme variables', () => {
    expect(parseAnsi('\x1b[91mx\x1b[0m')).toEqual([{ text: 'x', color: 'var(--ansi-bright-red, #f14c4c)' }])
    expect(parseAnsi('\x1b[32mx')).toEqual([{ text: 'x', color: 'var(--ansi-green, #0dbc79)' }])
  })

  it('maps 256-colour greys', () => {
    expect(parseAnsi('\x1b[38;5;243mx')).toEqual([{ text: 'x', color: 'rgb(118, 118, 118)' }])
  })

  it('ignores unknown codes without losing text', () => {
    expect(parseAnsi('\x1b[1ma\x1b[4mb')).toEqual([{ text: 'a' }, { text: 'b' }])
  })

  it('drops empty spans', () => {
    expect(parseAnsi('\x1b[31m\x1b[0m')).toEqual([])
  })
})

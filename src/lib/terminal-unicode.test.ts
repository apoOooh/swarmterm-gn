import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { enableUnicode11 } from './terminal-unicode'

function cursorXAfter(term: Terminal, text: string): Promise<number> {
  return new Promise((resolve) => term.write(text, () => resolve(term.buffer.active.cursorX)))
}

describe('enableUnicode11', () => {
  it('measures emoji as 1 cell by default (Unicode 6)', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 2 })
    expect(await cursorXAfter(term, '✅')).toBe(1)
    term.dispose()
  })

  it.each(['✅', '❌', '\u{1F536}'])('measures %s as 2 cells', async (ch) => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 2 })
    enableUnicode11(term)
    expect(term.unicode.activeVersion).toBe('11')
    expect(await cursorXAfter(term, ch)).toBe(2)
    term.dispose()
  })

  // xterm's unicode11 provider is per-codepoint: it does not join ZWJ
  // sequences or pair regional indicators. The family emoji therefore measures
  // as the sum of its parts (3 emoji x 2 cells + 2 ZWJ x 0 cells = 6), and a
  // flag as two 2-cell regional indicators (4), not the single 2-cell glyph
  // a grapheme-aware terminal would use.
  it.each([
    ['family ZWJ sequence', '\u{1F468}‍\u{1F469}‍\u{1F467}', 6],
    ['flag (regional indicator pair)', '\u{1F1E9}\u{1F1EA}', 4]
  ])('measures %s per codepoint', async (_name, seq, cells) => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 2 })
    enableUnicode11(term)
    expect(await cursorXAfter(term, seq)).toBe(cells)
    term.dispose()
  })
})

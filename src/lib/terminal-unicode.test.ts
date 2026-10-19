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
  // sequences. The family emoji measures as the sum of its parts (3 emoji x 2
  // cells + 2 ZWJ x 0 cells = 6). Regional indicators are narrow (1 cell
  // each), so a flag is 2 cells in total, which is also what a
  // grapheme-aware terminal would use for the glyph.
  it.each([
    ['family ZWJ sequence', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 6],
    ['flag (regional indicator pair)', '\u{1F1E9}\u{1F1EA}', 2]
  ])('measures %s per codepoint', async (_name, seq, cells) => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 2 })
    enableUnicode11(term)
    expect(await cursorXAfter(term, seq)).toBe(cells)
    term.dispose()
  })
})

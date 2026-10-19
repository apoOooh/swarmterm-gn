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
})

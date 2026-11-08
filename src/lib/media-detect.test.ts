import { describe, expect, it } from 'vitest'
import { detectMediaPaths, stitchTableRows, MAX_CARRY, MediaOutputBuffer, MISS_MAX_TRIES, MISS_RETRY_MS, OVERLAP, SeenPaths } from './media-detect'

describe('detectMediaPaths', () => {
  it('ignores output without a media extension', () => {
    expect(detectMediaPaths('cargo build finished in 3.2s\nsrc/main.rs:12')).toEqual([])
    expect(detectMediaPaths('file.pngx and image.png2')).toEqual([])
  })

  it('finds absolute Windows paths anywhere in a line', () => {
    expect(detectMediaPaths('Saved screenshot to C:\\Users\\me\\AppData\\Local\\Temp\\shot.png.')).toEqual([
      'C:\\Users\\me\\AppData\\Local\\Temp\\shot.png'
    ])
    expect(detectMediaPaths('-> g:/ai/out/clip.MP4, done')).toEqual(['g:/ai/out/clip.MP4'])
  })

  it('keeps spaces inside absolute and quoted paths', () => {
    expect(detectMediaPaths('wrote C:\\My Shots\\before after.jpeg')).toEqual(['C:\\My Shots\\before after.jpeg'])
    expect(detectMediaPaths('open "out dir/compare 2.webp" now')).toEqual(['out dir/compare 2.webp'])
    expect(detectMediaPaths("see 'D:\\a b\\c.gif'")).toEqual(['D:\\a b\\c.gif'])
  })

  it('finds relative paths and bare file names', () => {
    expect(detectMediaPaths('Created ./screens/home.png and ah-sheet.png')).toEqual(['./screens/home.png', 'ah-sheet.png'])
    expect(detectMediaPaths('(see ..\\docs\\demo.webm)')).toEqual(['..\\docs\\demo.webm'])
  })

  it('separates several paths on one line and dedupes', () => {
    expect(detectMediaPaths('C:\\a\\one.png vs C:\\a\\two.png vs C:\\a\\one.png')).toEqual(['C:\\a\\one.png', 'C:\\a\\two.png'])
  })

  it('strips ANSI colour around and inside a path', () => {
    expect(detectMediaPaths('\x1b[32mC:\\tmp\\\x1b[1mshot.png\x1b[0m done')).toEqual(['C:\\tmp\\shot.png'])
    expect(detectMediaPaths('\x1b]8;;file:///x\x07a/b.gif\x1b]8;;\x07')).toEqual(['a/b.gif'])
  })

  it('treats cursor moves as spaces', () => {
    expect(detectMediaPaths('Wrote\x1b[1Cshot.png')).toEqual(['shot.png'])
  })

  it('does not let a prose-swallowing drive match hide a real file', () => {
    expect(detectMediaPaths('cd C:\\proj && echo x.png')).toEqual(['x.png'])
  })

  it('leaves URLs alone', () => {
    expect(detectMediaPaths('GET https://example.com/img/logo.png 200')).toEqual([])
  })
})

// A real Claude Code table: box borders, long paths hard-wrapped inside column 2.
const DIR = 'C:\\Users\\pawel\\AppData\\Local\\Temp\\claude\\G--ai-claude\\91f60608-d216-485d-a4f4-cc1051d2b8c7\\scratchpad\\pc-shots'
const SHOTS = ['rows-cmp.png', '0-pc-dev-960.png', '1-pc-covers-960.png', 'diff-0-1-pc-covers-960.png'].map((f) => `${DIR}\\${f}`)
const PAIR = [`${DIR}\\0-pc-dev.png`, `${DIR}\\1-pc-covers.png`]
const ROWS: [string, string][] = [
  ['Compare', SHOTS[0]], ['Dev', SHOTS[1]], ['Covers', SHOTS[2]], ['Diff', SHOTS[3]], ['Full size', `${PAIR[0]} and ${PAIR[1]}`],
]
const B = '\u2502'
/** Colours every path piece per line, as the CLI re-emits colour after a wrap. */
const paint = (s: string): string => s.replace(/\S+/g, (w) => (w === 'and' ? w : `\x1b[36m${w}\x1b[39m`))

/** Word-wraps like the CLI: break at spaces, cut a token longer than the cell. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(' ')) {
    let w = word
    if (cur && cur.length + 1 + w.length <= width) { cur += ' ' + w; continue }
    if (cur) lines.push(cur)
    while (w.length > width) { lines.push(w.slice(0, width)); w = w.slice(width) }
    cur = w
  }
  lines.push(cur)
  return lines
}

function table(total: number): string {
  const w1 = 10
  const w2 = total - w1 - 7
  const out = [`\u250c${'\u2500'.repeat(w1 + 2)}\u252c${'\u2500'.repeat(w2 + 2)}\u2510`]
  for (const [a, b] of ROWS) {
    wrap(b, w2).forEach((r, i) => out.push(`${B} ${(i === 0 ? a : '').padEnd(w1)} ${B} ${paint(r)}${' '.repeat(w2 - r.length)} ${B}`))
  }
  out.push(`\u2514${'\u2500'.repeat(w1 + 2)}\u2534${'\u2500'.repeat(w2 + 2)}\u2518`)
  return out.join('\r\n') + '\r\n'
}

describe('wrapped table cells', () => {
  for (const width of [100, 135]) {
    it(`detects all full paths in a table wrapped at ${width} columns`, () => {
      const t = table(width)
      expect(t.split('\n').length).toBeGreaterThan(ROWS.length + 3)
      expect(detectMediaPaths(t)).toEqual([...SHOTS, ...PAIR])
    })

    it(`keeps a row whole across scans at ${width} columns`, () => {
      const b = new MediaOutputBuffer()
      const found: string[] = []
      // One line per scan: every continuation arrives after its row started.
      for (const line of table(width).split(/(?<=\n)/)) { b.append(line); found.push(...detectMediaPaths(b.take())) }
      found.push(...detectMediaPaths(b.drain()))
      expect(found).toEqual([...SHOTS, ...PAIR])
    })
  }

  it('joins at word breaks with a space and leaves other lines alone', () => {
    expect(stitchTableRows(`${B} a ${B} see     ${B}\n${B}   ${B} out.png ${B}\nplain`)).toBe(`${B} a ${B} see out.png ${B}\nplain`)
    expect(stitchTableRows('no table')).toBe('no table')
  })

  it('keeps a real space after a directory when the piece did not fill its cell', () => {
    expect(stitchTableRows(`${B} a ${B} see /tmp/out/  ${B}\n${B}   ${B} and more       ${B}`)).toBe(`${B} a ${B} see /tmp/out/ and more ${B}`)
    // A hard cut right after a separator fills the cell and glues.
    expect(stitchTableRows(`${B} a ${B} C:\\tmp\\ ${B}\n${B}   ${B} x.png   ${B}`)).toBe(`${B} a ${B} C:\\tmp\\x.png ${B}`)
  })

  it('finds full paths with CRLF line ends and coloured borders', () => {
    // table() already joins with CRLF; also colour every border and row.
    const t = table(100).replace(/[\u2502\u250c\u2510\u2514\u2518\u252c\u2534\u2500]+/g, (m) => `\x1b[90m${m}\x1b[39m`)
    expect(t).toContain('\r\n')
    expect(detectMediaPaths(t)).toEqual([...SHOTS, ...PAIR])
    const b = new MediaOutputBuffer()
    const found: string[] = []
    for (const line of t.split(/(?<=\r\n)/)) { b.append(line); found.push(...detectMediaPaths(b.take())) }
    found.push(...detectMediaPaths(b.drain()))
    expect(found).toEqual([...SHOTS, ...PAIR])
  })

  it('leaves tree and git-graph lines alone', () => {
    const tree = `${B}   ${B}   ├── shot.png\n${B}   ${B}   x/y.gif\n`
    expect(stitchTableRows(tree)).toBe(tree.replace(/\n$/, '\n'))
    expect(detectMediaPaths(tree)).toEqual(['shot.png', 'x/y.gif'])
  })
})

describe('MediaOutputBuffer', () => {
  it('reassembles a path split across chunks before scanning', () => {
    const b = new MediaOutputBuffer()
    b.append('saved C:\\tmp\\sh')
    expect(b.take()).toBe('')
    b.append('ot.p')
    b.append('ng\r\nnext')
    expect(detectMediaPaths(b.take())).toEqual(['C:\\tmp\\shot.png'])
    expect(b.drain()).toBe('next')
  })

  it('reassembles a split escape sequence', () => {
    const b = new MediaOutputBuffer()
    b.append('a/b.png\x1b[3')
    b.append('2m\n')
    expect(detectMediaPaths(b.take())).toEqual(['a/b.png'])
  })

  it('bounds a newline-less stream but keeps an overlap for a straddling path', () => {
    const b = new MediaOutputBuffer()
    b.append('x'.repeat(MAX_CARRY) + ' C:\\t\\a.p')
    expect(b.take().length).toBe(MAX_CARRY + 9)
    b.append('ng\n')
    expect(detectMediaPaths(b.take())).toEqual(['C:\\t\\a.png'])
    expect(OVERLAP).toBeGreaterThan(9)
  })

  it('holds back a trailing table row until a non-table line follows', () => {
    const b = new MediaOutputBuffer()
    b.append(`x\n${B} a ${B} C:\\t\\lo ${B}\n`)
    expect(b.take()).toBe('x\n')
    b.append(`${B}   ${B} ng.png  ${B}\ndone\n`)
    expect(detectMediaPaths(b.take())).toEqual(['C:\\t\\long.png'])
  })

  it('drains a partial last line', () => {
    const b = new MediaOutputBuffer()
    b.append('prompt> shot.gif')
    expect(b.take()).toBe('')
    expect(b.hasPartial).toBe(true)
    expect(b.drain()).toBe('prompt> shot.gif')
    expect(b.hasPartial).toBe(false)
  })
})

describe('SeenPaths', () => {
  it('never re-offers a confirmed path, case-insensitively', () => {
    const s = new SeenPaths()
    expect(s.offer('C:\A.png', 0)).toBe(true)
    s.confirm('C:\A.png')
    expect(s.offer('c:\a.PNG', 1e9)).toBe(false)
  })

  it('retries a miss after a delay, a bounded number of times', () => {
    const s = new SeenPaths()
    let t = 0
    expect(s.offer('out.png', t)).toBe(true)
    expect(s.offer('out.png', t + 10)).toBe(false)
    for (let i = 1; i < MISS_MAX_TRIES; i++) {
      t += MISS_RETRY_MS
      expect(s.offer('out.png', t)).toBe(true)
    }
    expect(s.offer('out.png', t + 10 * MISS_RETRY_MS)).toBe(false)
  })

  it('stays bounded', () => {
    const s = new SeenPaths(2)
    s.offer('a.png', 0); s.confirm('a.png')
    s.offer('b.png', 0); s.confirm('b.png')
    s.offer('c.png', 0); s.confirm('c.png')
    expect(s.offer('a.png', 0)).toBe(true)
  })
})

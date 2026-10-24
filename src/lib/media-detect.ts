/**
 * Passive media detection: finds image/video paths an agent prints in a pane
 * so the Media gallery can offer them (as names; the user opens them).
 *
 * Runs off the pty hot path: the registry only appends raw chunks to a
 * `MediaOutputBuffer` and scans it on a debounce timer. The scan itself
 * starts with a single case-insensitive extension test, so ordinary output
 * (the overwhelming majority) costs one regex pass and nothing else.
 * Existence is NOT checked here; the backend resolves and allow-lists.
 */

export const MEDIA_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'm4v', 'mov', 'webm'] as const

const EXT = '(?:png|jpe?g|webp|gif|mp4|m4v|mov|webm)'
/** Cheap prefilter: no media extension substring, no work. */
const EXT_PREFILTER = new RegExp(`\\.${EXT}(?![A-Za-z0-9])`, 'i')
// CSI/OSC/other escape sequences; agents colour paths, so strip before matching.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
// eslint-disable-next-line no-control-regex
const CURSOR_MOVE_RE = /\x1b\[[0-9;]*[CGHf]/g
// After the extension: end, whitespace or closing punctuation, never more name.
const END = `(?=$|[\\s"'\`)\\]}>,;:!?]|\\.(?:\\s|$))`
/** "..." / '...' / `...` wrapped paths may contain spaces. */
const QUOTED_RE = new RegExp(`(["'\`])([^"'\`\\r\\n]{1,1024}?\\.${EXT})\\1`, 'gi')
/**
 * Absolute Windows path anywhere, spaces allowed: lazy up to the first media
 * extension that ends a token. Starts at the drive letter, so leading prose
 * is never swallowed. `&` and `;` (legal in names, but rare) end it too, so a
 * shell line like `cd C:\proj && echo x.png` does not glue into one path.
 */
const ABS_RE = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^\\r\\n"<>|?*:&;]{0,1024}?\\.${EXT}${END}`, 'gi')
/** Relative path without spaces, e.g. `out/shot.png`, `./a.gif`, `shot.png` (POSIX-style `/c/...` is not supported). */
const REL_RE = new RegExp(`(?<![^\\s"'\`(\\[{<=])(?:\\.{1,2}[\\\\/])?[^\\s\\\\/:*?"'\`<>|()\\[\\]{}]+(?:[\\\\/][^\\s\\\\/:*?"'\`<>|]+)*\\.${EXT}${END}`, 'gi')

export const MAX_MEDIA_PER_SCAN = 20

/** Paths in plain (ANSI-free) text, in order of appearance, deduplicated. */
export function detectMediaPaths(text: string): string[] {
  if (!EXT_PREFILTER.test(text)) return []
  // Cursor moves stand in for spaces in TUI redraws: keep tokens apart.
  const clean = stitchTableRows(text.replace(CURSOR_MOVE_RE, ' ').replace(ANSI_RE, ''))
  // Drop URLs: `https://x/y.png` is the browser's business, not a file.
  const masked = clean.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, (m) => ' '.repeat(m.length))
  const hits: { start: number; end: number; path: string }[] = []
  const taken = (s: number, e: number): boolean => hits.some((h) => s < h.end && e > h.start)
  const collect = (re: RegExp, group: number): void => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      const path = m[group].trim()
      const start = m.index + m[0].indexOf(m[group])
      const end = start + m[group].length
      if (path && !taken(start, end)) hits.push({ start, end, path })
      if (m[0].length === 0) re.lastIndex += 1
    }
  }
  // Most specific first: quotes delimit exactly, then drive paths, then the rest.
  collect(QUOTED_RE, 2)
  collect(ABS_RE, 0)
  collect(REL_RE, 0)
  hits.sort((a, b) => a.start - b.start)
  const out: string[] = []
  for (const h of hits) {
    if (!out.includes(h.path)) out.push(h.path)
    if (out.length >= MAX_MEDIA_PER_SCAN) break
  }
  return out
}

/** Vertical box-drawing border Claude Code (and others) draw markdown tables with. */
const CELL_BORDER = '│'

/**
 * Positions of the cell borders in a line; null for a line that is no table
 * row. A row opens AND closes with a border and has at least two cells, so
 * `tree`/git-graph lines (`│   │   ├── shot.png`, text after the last border)
 * never count and keep their paths. Positions are UTF-16 indexes: a wide
 * character in another cell shifts them, so such a row is simply not joined.
 */
function borderColumns(line: string): number[] | null {
  const t = line.trim()
  if (!t.startsWith(CELL_BORDER) || !t.endsWith(CELL_BORDER)) return null
  const cols: number[] = []
  for (let i = line.indexOf(CELL_BORDER); i >= 0; i = line.indexOf(CELL_BORDER, i + 1)) cols.push(i)
  return cols.length >= 3 ? cols : null
}

const cellsOf = (line: string, cols: number[]): string[] =>
  cols.slice(1).map((c, i) => line.slice(cols[i] + 1, c).trim())

/** A table line whose first cell is blank continues the row above (a hard-wrapped cell). */
const isContinuation = (line: string, cols: number[]): boolean => cellsOf(line, cols)[0] === ''

/** Whether each cell's text runs up to its border (at most one padding space). */
const filledOf = (line: string, cols: number[]): boolean[] =>
  cols.slice(1).map((c, i) => {
    const raw = line.slice(cols[i] + 1, c)
    return raw.trim() !== '' && raw.trimEnd().length >= raw.length - 1
  })

/**
 * Join a wrapped cell's pieces. The wrapper breaks at a space whenever the
 * next word fits on a fresh line, and cuts inside a token only when it is
 * longer than the cell, which leaves that piece filling the cell to its
 * border. So a piece glues on without a space only when it FILLED its cell
 * and ends inside a path (last token has a separator, no media extension
 * yet); this holds for a cut right after a `\` too. A piece with room left
 * was broken at a real space (`see /tmp/out/` + `and more`) and gets one.
 * A bare file name cut mid-name has no separator and also gets a space, so
 * only its tail is found; absolute paths are what tables wrap.
 */
function joinCell(above: string, next: string, filled: boolean): string {
  if (!above || !next) return above || next
  const last = above.slice(above.lastIndexOf(' ') + 1)
  const midPath = filled && /[\\/]/.test(last) && !EXT_PREFILTER.test(last)
  return above + (midPath ? '' : ' ') + next
}

/**
 * Terminal tables hard-wrap long cells across lines, which splits an
 * absolute path so only its tail would match. Each row and its continuation
 * lines (same border columns, blank first cell) become one line of joined
 * cells. Lines are expected ANSI-free; anything that is no table passes as is.
 */
export function stitchTableRows(text: string): string {
  if (!text.includes(CELL_BORDER)) return text
  const lines = text.split(/\r?\n|\r/)
  const out: string[] = []
  /** `filled`: whether each cell's latest piece reached its border (see joinCell). */
  let row: { cols: number[]; cells: string[]; filled: boolean[] } | null = null
  const flush = (): void => {
    if (row) out.push(`${CELL_BORDER} ${row.cells.join(` ${CELL_BORDER} `)} ${CELL_BORDER}`)
    row = null
  }
  for (const line of lines) {
    const cols = borderColumns(line)
    const same = !!cols && !!row && cols.length === row.cols.length && cols.every((c, i) => c === row!.cols[i])
    if (cols && same && isContinuation(line, cols)) {
      const cells = cellsOf(line, cols)
      const filled = filledOf(line, cols)
      row!.cells = row!.cells.map((c, i) => joinCell(c, cells[i], row!.filled[i]))
      // An empty piece keeps the flag of the text it did not extend.
      row!.filled = row!.filled.map((f, i) => (cells[i] ? filled[i] : f))
      continue
    }
    flush()
    if (cols) row = { cols, cells: cellsOf(line, cols), filled: filledOf(line, cols) }
    else out.push(line)
  }
  flush()
  return out.join('\n')
}

/**
 * How much of the complete lines `take` holds back while they may still be
 * a wrapped table row: from the start of the last row (a bordered line with a
 * non-blank first cell) to the end. 0 when the text does not end in a table.
 */
function tableTail(done: string): number {
  // Only a held-back tail of at most MAX_CARRY matters: look at no more, so a
  // TUI that draws borders all the time costs a bounded slice per take.
  const tail = done.slice(-(MAX_CARRY + 1))
  if (!tail.includes(CELL_BORDER)) return 0
  // Start offset of every complete line in the tail (its cut first line is
  // skipped unless it is the whole text); `done` ends with a line break.
  const starts = tail.length === done.length ? [0] : []
  for (const m of tail.matchAll(/\r?\n|\r/g)) starts.push(m.index + m[0].length)
  for (let i = starts.length - 2; i >= 0; i--) {
    const line = tail.slice(starts[i], starts[i + 1]).replace(/[\r\n]+$/, '').replace(CURSOR_MOVE_RE, ' ').replace(ANSI_RE, '')
    const cols = borderColumns(line)
    if (!cols) return 0
    if (!isContinuation(line, cols)) return tail.length - starts[i]
  }
  return 0
}

/** Longest unterminated tail kept between flushes (a path split across chunks). */
export const MAX_CARRY = 2048
/** Tail re-scanned after a newline-less cut. */
export const OVERLAP = 256
/** Upper bound of buffered output between flushes; a flood keeps only its end. */
export const MAX_PENDING = 256 * 1024

/**
 * Accumulates pty chunks and hands back only COMPLETE lines on `take()`, so
 * a path (or an escape sequence) split across two chunks is scanned whole.
 * `append` is O(1)-ish string concatenation: the only work on the hot path.
 */
export class MediaOutputBuffer {
  private pending = ''

  append(chunk: string): void {
    this.pending += chunk
    if (this.pending.length > MAX_PENDING) this.pending = this.pending.slice(-MAX_PENDING)
  }

  get hasPartial(): boolean {
    return this.pending.length > 0
  }

  /**
   * Complete lines since the last take; the partial last line is carried
   * over, and so is a trailing table row (see `tableTail`).
   */
  take(): string {
    const cut = Math.max(this.pending.lastIndexOf('\n'), this.pending.lastIndexOf('\r'))
    if (cut < 0) {
      // No line end yet: keep waiting, but never let a newline-less stream grow.
      if (this.pending.length > MAX_CARRY) {
        // Keep an overlap so a path straddling the cut is still seen whole
        // next time (the seen set absorbs the duplicate).
        const all = this.pending
        this.pending = all.slice(-OVERLAP)
        return all
      }
      return ''
    }
    let done = this.pending.slice(0, cut + 1)
    this.pending = this.pending.slice(cut + 1)
    // A table row's wrapped continuation may still be on its way: keep the
    // last row back until a non-table line follows (or `drain` on quiet, so
    // a bordered box that stays last on screen, like an input box, is still
    // scanned one interval later). A row longer than MAX_CARRY is not held
    // and may be split across scans like before.
    const hold = tableTail(done)
    if (hold > 0 && hold + this.pending.length <= MAX_CARRY) {
      this.pending = done.slice(-hold) + this.pending
      done = done.slice(0, -hold)
    }
    if (this.pending.length > MAX_CARRY) this.pending = this.pending.slice(-MAX_CARRY)
    return done
  }

  /** Everything, partial line included (pane went quiet: the prompt line is final). */
  drain(): string {
    const all = this.pending
    this.pending = ''
    return all
  }
}

/** How often and how long a printed path that is not (yet) a file is retried. */
export const MISS_RETRY_MS = 3000
export const MISS_MAX_TRIES = 3

/**
 * Per-pane lookup memory, compared case-insensitively and bounded. A found
 * path is never offered again (agents reprint paths on every redraw). A miss
 * may be retried: "Saving to out.png..." is printed BEFORE the file exists,
 * so it is offered again when reprinted after MISS_RETRY_MS, at most
 * MISS_MAX_TRIES times in total.
 */
export class SeenPaths {
  private readonly found = new Set<string>()
  private readonly misses = new Map<string, { at: number; tries: number }>()
  constructor(private readonly max = 500) {}

  /** Whether the path should be looked up now; counts the attempt. */
  offer(path: string, now: number): boolean {
    const key = path.toLowerCase()
    if (this.found.has(key)) return false
    const miss = this.misses.get(key)
    if (miss && (miss.tries >= MISS_MAX_TRIES || now - miss.at < MISS_RETRY_MS)) return false
    this.misses.delete(key)
    this.misses.set(key, { at: now, tries: (miss?.tries ?? 0) + 1 })
    if (this.misses.size > this.max) this.misses.delete(this.misses.keys().next().value as string)
    return true
  }

  /** The backend confirmed the path: never offer it again. */
  confirm(path: string): void {
    const key = path.toLowerCase()
    this.misses.delete(key)
    this.found.add(key)
    if (this.found.size > this.max) this.found.delete(this.found.values().next().value as string)
  }
}

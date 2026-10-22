/**
 * Passive media detection: finds image/video paths an agent prints in a pane
 * so the Media gallery can offer them without the agent calling media.show.
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
  const clean = text.replace(CURSOR_MOVE_RE, ' ').replace(ANSI_RE, '')
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

  /** Complete lines since the last take; the partial last line is carried over. */
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
    const done = this.pending.slice(0, cut + 1)
    this.pending = this.pending.slice(cut + 1)
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

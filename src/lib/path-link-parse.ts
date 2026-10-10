/**
 * Detecting file paths in raw terminal text, and splitting a `:line:col` style
 * suffix off one. Pure — no xterm, no Tauri — so the regex work can be tested
 * without a DOM or a pty. Mirrors VS Code's terminalLinkParsing.ts; the
 * validation half (does this file actually exist?) lives in Rust, because the
 * webview has no filesystem.
 */

/** Lines longer than this are skipped entirely — link scanning is per-render. */
export const MAX_LINE_LENGTH = 2000
/** Cap per line so one pathological line can't queue hundreds of FS probes. */
export const MAX_LINKS_PER_LINE = 10
/** Anything longer is not a path anyone typed; don't pay to canonicalize it. */
export const MAX_CANDIDATE_LENGTH = 1024

export interface ParsedPath {
  path: string
  line?: number
  col?: number
}

/**
 * Ordered most-specific first. Every pattern is anchored at both ends and uses a
 * lazy path group, so on `C:\src\foo.ts:42` the engine is forced to expand the
 * path until the tail is genuinely numeric — the drive letter can never be
 * mistaken for a line number.
 */
const SUFFIX_PATTERNS: readonly RegExp[] = [
  /^(.+?):(\d+):(\d+)$/,
  /^(.+?)\((\d+),(\d+)\)$/,
  /^(.+?)\((\d+)\)$/,
  /^(.+?)",? line (\d+)$/,
  /^(.+?):(\d+)$/,
]

export function parsePathSuffix(text: string): ParsedPath {
  // `File "x.py", line 42` — drop the leading `File "` before matching so the
  // quoted-path pattern only has to describe the tail.
  const body = text.startsWith('File "') ? text.slice('File "'.length) : text
  for (const re of SUFFIX_PATTERNS) {
    const m = re.exec(body)
    if (!m) continue
    const line = Number(m[2])
    const col = m[3] === undefined ? undefined : Number(m[3])
    return col === undefined ? { path: m[1], line } : { path: m[1], line, col }
  }
  return { path: body }
}

// A path segment: no whitespace, no separator, and none of the characters
// Windows forbids in filenames. Excluding `:` keeps the suffix out of the path.
const SEG = '[^\\s\\\\/:*?"<>|]+'
const SEP = '[\\\\/]'
const CANDIDATE_RE = new RegExp(
  // optional drive or leading separator, then >=1 separator between segments.
  // Requiring a separator is the main false-positive control: it costs us bare
  // `foo.ts` mentions but keeps ordinary prose out of the link layer.
  `(?:[A-Za-z]:)?(?:${SEP})?${SEG}(?:${SEP}${SEG})+` +
    // optional `:42`, `:42:9`, `(42)` or `(42,9)`
    `(?::\\d+(?::\\d+)?|\\(\\d+(?:,\\d+)?\\))?`,
  'g'
)

/** Trailing characters that end a sentence rather than a path. */
const TRAILING_PUNCTUATION = /[.,;:!?'")\]}]+$/

export interface PathCandidate {
  text: string
  /** 0-based index into the line. */
  start: number
  /** 0-based, exclusive. */
  end: number
}

export function detectPathCandidates(lineText: string): PathCandidate[] {
  if (lineText.length > MAX_LINE_LENGTH) return []

  // Mask out URLs first so `https://example.com/a/b` — which matches the path
  // shape — is left to WebLinksAddon instead of becoming a bogus file link.
  const masked = lineText.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, (m) => ' '.repeat(m.length))

  const out: PathCandidate[] = []
  CANDIDATE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CANDIDATE_RE.exec(masked)) !== null && out.length < MAX_LINKS_PER_LINE) {
    let text = m[0]
    const start = m.index
    // A parenthesised suffix ends in `)`, which the punctuation trim would eat.
    if (!/\)$/.test(text)) text = text.replace(TRAILING_PUNCTUATION, '')
    if (text.length === 0 || text.length > MAX_CANDIDATE_LENGTH) continue
    out.push({ text, start, end: start + text.length })
  }
  return out
}

/**
 * The Name column of one Get-ChildItem / `dir` row (`-a----  10.10.2026  22:25  437 logo.svg`).
 * Bare names are no link candidates in prose (see CANDIDATE_RE); inside a listing the row
 * format itself is the false-positive control. Folder rows (`d-----`) are skipped — links
 * name files.
 */
export function listingEntry(line: string): PathCandidate | null {
  const m = /^([-a][-a-z]{5})\s+\S+\s+\S+\s+\d+\s+(\S.*?)\s*$/.exec(line)
  if (!m) return null
  const start = line.lastIndexOf(m[2])
  return { text: m[2], start, end: start + m[2].length }
}

const LISTING_HEADER =/^\s*(?:Directory|Verzeichnis|Répertoire|Directorio|Directory of)\s*:?\s+(\S.*?)\s*$/

/**
 * Folder a `dir` / Get-ChildItem listing names its entries relative to: the
 * nearest "Directory: X" ("Verzeichnis: X" on German Windows) header above the
 * line. `linesAbove` is ordered nearest-first. A PowerShell prompt line
 * (`PS …>`) ends the search — a header above it belongs to an older command.
 */
export function listingDirAbove(linesAbove: string[], maxLines = 300): string | null {
  for (const line of linesAbove.slice(0, maxLines)) {
    const m = LISTING_HEADER.exec(line)
    if (m) return m[1]
    if (/^PS [^>]*>/.test(line)) return null
  }
  return null
}

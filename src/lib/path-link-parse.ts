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
 * shape itself is the false-positive control. Folder rows (`d-----`, no Length column) come
 * back with `dir: true`.
 */
export function listingEntry(line: string): (PathCandidate & { dir: boolean }) | null {
  const m = /^([-ad][-a-z]{5})\s+\S+\s+\S+\s+(?:(\d+)\s+)?(\S.*?)\s*$/.exec(line)
  if (!m) return null
  const dir = m[1].startsWith('d')
  // A file row always has a Length; a folder row never does.
  if (dir === (m[2] !== undefined)) return null
  const start = line.lastIndexOf(m[3])
  return { text: m[3], start, end: start + m[3].length, dir }
}

const LISTING_HEADER = /^\s*(?:Directory|Verzeichnis|Répertoire|Directorio|Directory of)\s*:?\s+(\S.*?)\s*$/

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

/** No drive, no leading separator: resolved against some base folder. */
export function isRelativePath(path: string): boolean {
  return !/^(?:[A-Za-z]:|[\\/])/.test(path)
}

/**
 * `path` as an absolute Windows path, or null. Drive paths are kept as they
 * are; Git Bash's `/d/lab` (what agents print after a `cd` in their Bash tool)
 * becomes `D:\lab`. Any other posix path names nothing on this platform.
 */
export function absoluteWindowsPath(path: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(path)) return path
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(path)
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}` : null
}

/** Folder of an absolute path; null at a drive root, which is too broad to be a base. */
function parentDir(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return i <= 2 ? null : trimmed.slice(0, i)
}

/**
 * Absolute paths only, single segment included: CANDIDATE_RE needs two
 * segments, so `cd D:\swarmterm-testlab` — the most useful base of all — is
 * no candidate there. Drive form or Git Bash `/d/…`; the lookbehind keeps the
 * `/a/b` of a URL or a relative path out.
 */
const ABSOLUTE_RE = new RegExp(`(?<![\\w:\\\\/.-])(?:[A-Za-z]:${SEP}(?:${SEG}(?:${SEP}${SEG})*)?|/[A-Za-z](?:/${SEG})+)`, 'g')

function absolutePathsIn(line: string): string[] {
  if (line.length > MAX_LINE_LENGTH) return []
  const masked = line.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, (m) => ' '.repeat(m.length))
  return Array.from(masked.matchAll(ABSOLUTE_RE), (m) => m[0].replace(TRAILING_PUNCTUATION, ''))
    .filter((p) => p.length > 0 && p.length <= MAX_CANDIDATE_LENGTH)
    .slice(0, MAX_LINKS_PER_LINE)
}

const baseKey = (p: string): string => p.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '')

export interface RelativeBaseOptions {
  /** Absolute paths read, in line order; each yields itself and its folder. */
  maxSources?: number
  /** Bases already tried (the pane's cwd), compared case-insensitively. */
  exclude?: readonly string[]
}

/**
 * Further base folders for a relative path that did not resolve against the
 * pane's cwd (SWA-62): an agent or tool often prints paths relative to ITS
 * folder (`out/shot.png` after working in `D:\lab`), so the link never
 * appeared and a Ctrl+click did nothing. Candidates are the absolute paths on
 * the same line, then on the lines above (`linesAbove` ordered nearest line
 * leading), each as itself (a folder) and as its parent (a file in it). The
 * caller only asks Rust whether `base/path` is an existing file, and the cwd
 * stays the leading try — nothing here widens what can be opened.
 */
export function relativeBases(lineText: string, linesAbove: readonly string[], options: RelativeBaseOptions = {}): string[] {
  const maxSources = options.maxSources ?? 3
  const seen = new Set((options.exclude ?? []).map(baseKey))
  const out: string[] = []
  const add = (p: string | null): void => {
    if (!p || seen.has(baseKey(p))) return
    seen.add(baseKey(p))
    out.push(p)
  }
  let sources = 0
  for (const line of [lineText, ...linesAbove]) {
    for (const found of absolutePathsIn(line)) {
      const abs = absoluteWindowsPath(found)
      if (!abs) continue
      add(abs)
      add(parentDir(abs))
      if (++sources >= maxSources) return out
    }
  }
  return out
}

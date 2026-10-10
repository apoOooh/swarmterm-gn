/**
 * How Markdown files open and which external Markdown app the "Open in MarkText"
 * action launches. Persisted to localStorage. The rendered view is the default
 * because a .md file is usually read, not edited — raw source is one click away.
 */
export type MarkdownMode = 'editor' | 'split' | 'preview'

export interface MarkdownPrefs {
  defaultMode: MarkdownMode
  /** Explicit MarkText executable. Empty = auto-detect the standard install paths. */
  marktextPath: string
}

export const DEFAULT_MARKDOWN_PREFS: MarkdownPrefs = { defaultMode: 'preview', marktextPath: '' }

export const MARKDOWN_PREF_STORAGE_KEY = 'swarmterm-markdown-prefs'

const MODES: readonly MarkdownMode[] = ['editor', 'split', 'preview']

export interface MarkdownPrefStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path)

/** Per-field tolerant parse: an invalid field falls back alone, never the whole blob. */
export function readStoredMarkdownPrefs(storage: MarkdownPrefStorage): MarkdownPrefs {
  const raw = storage.getItem(MARKDOWN_PREF_STORAGE_KEY)
  if (raw === null) return DEFAULT_MARKDOWN_PREFS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_MARKDOWN_PREFS
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_MARKDOWN_PREFS
  const obj = parsed as Record<string, unknown>
  return {
    defaultMode: MODES.includes(obj.defaultMode as MarkdownMode) ? (obj.defaultMode as MarkdownMode) : DEFAULT_MARKDOWN_PREFS.defaultMode,
    marktextPath: typeof obj.marktextPath === 'string' ? obj.marktextPath.trim() : ''
  }
}

export function storeMarkdownPrefs(storage: MarkdownPrefStorage, prefs: MarkdownPrefs): void {
  storage.setItem(MARKDOWN_PREF_STORAGE_KEY, JSON.stringify(prefs))
}

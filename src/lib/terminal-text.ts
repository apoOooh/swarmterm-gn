/** Injectable storage surface (mirrors ShellPrefStorage) so tests pass a fake. */
export interface TextPrefStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * What Ctrl+mouse wheel over a terminal resizes: only the pane under the
 * pointer (an offset on top of the global size), the global size itself, or
 * nothing (the wheel event reaches xterm as before).
 */
export type WheelZoomMode = 'pane' | 'global' | 'off'

export const WHEEL_ZOOM_MODES: readonly WheelZoomMode[] = ['pane', 'global', 'off']

/** User-configurable terminal text settings. */
export interface TerminalTextPref {
  /** Full CSS font-family stack; should end in `monospace`. */
  fontFamily: string
  /** Font size in px. */
  fontSize: number
  /** Line height multiplier. */
  lineHeight: number
  /** Enable programming ligatures via CSS font-feature-settings. */
  ligatures: boolean
  /** Ctrl+mouse wheel zoom behaviour. */
  wheelZoom: WheelZoomMode
  /** Lines of scrollback per pane. Each line costs ~cols x 12 bytes in the
   *  xterm buffer, so this is the main per-pane memory knob. */
  scrollback: number
}

/** A selectable monospace font in the curated catalog. */
export interface MonoFont {
  id: string
  label: string
  platform: string
  /** Full CSS stack ending in monospace. */
  stack: string
  /** True if this font ships programming ligatures. */
  ligatures: boolean
}

/** The historical hardcoded stack — the System Default option and pref default. */
export const SYSTEM_FONT_STACK =
  '"Cascadia Mono", "Consolas", "JetBrains Mono", monospace'

/** Curated cross-platform monospace fonts. Order = display order. */
export const MONO_FONTS: readonly MonoFont[] = [
  { id: 'system', label: 'System Default', platform: 'Cross-platform', stack: SYSTEM_FONT_STACK, ligatures: false },
  { id: 'cascadia-code', label: 'Cascadia Code', platform: 'Windows', stack: '"Cascadia Code", monospace', ligatures: true },
  { id: 'cascadia-mono', label: 'Cascadia Mono', platform: 'Windows', stack: '"Cascadia Mono", monospace', ligatures: false },
  { id: 'consolas', label: 'Consolas', platform: 'Windows', stack: '"Consolas", monospace', ligatures: false },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', platform: 'Cross-platform', stack: '"JetBrains Mono", monospace', ligatures: true },
  { id: 'fira-code', label: 'Fira Code', platform: 'Cross-platform', stack: '"Fira Code", monospace', ligatures: true },
  { id: 'sf-mono', label: 'SF Mono', platform: 'macOS', stack: '"SF Mono", "SFMono-Regular", Menlo, monospace', ligatures: false },
  { id: 'menlo', label: 'Menlo', platform: 'macOS', stack: 'Menlo, monospace', ligatures: false },
  { id: 'monaco', label: 'Monaco', platform: 'macOS', stack: 'Monaco, monospace', ligatures: false },
  { id: 'dejavu-mono', label: 'DejaVu Sans Mono', platform: 'Linux', stack: '"DejaVu Sans Mono", monospace', ligatures: false },
  { id: 'ubuntu-mono', label: 'Ubuntu Mono', platform: 'Linux', stack: '"Ubuntu Mono", monospace', ligatures: false }
] as const

export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 32
export const LINE_HEIGHT_MIN = 1.0
export const LINE_HEIGHT_MAX = 2.0
export const SCROLLBACK_MIN = 500
export const SCROLLBACK_MAX = 50000
/** Values offered in Settings; a stored value outside the list is still honoured. */
export const SCROLLBACK_CHOICES: readonly number[] = [1000, 2500, 5000, 10000, 25000, 50000]

/** Default text prefs — reproduce the historical hardcoded rendering exactly. */
export const DEFAULT_TERMINAL_TEXT: TerminalTextPref = {
  fontFamily: SYSTEM_FONT_STACK,
  fontSize: 13,
  lineHeight: 1.0,
  ligatures: false,
  wheelZoom: 'pane',
  scrollback: 5000
}

/** localStorage key the text prefs are persisted under. */
export const TERMINAL_TEXT_STORAGE_KEY = 'cc-terminal-text'

/** Clamp a font size into [FONT_SIZE_MIN, FONT_SIZE_MAX]; non-finite → default. */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_TEXT.fontSize
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)))
}

/** Clamp a line height into [LINE_HEIGHT_MIN, LINE_HEIGHT_MAX]; non-finite → default. */
export function clampLineHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_TEXT.lineHeight
  const clamped = Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, n))
  // Round to one decimal to avoid float drift from stepper arithmetic.
  return Math.round(clamped * 10) / 10
}

/** Clamp a scrollback line count into [SCROLLBACK_MIN, SCROLLBACK_MAX]; non-finite → default. */
export function clampScrollback(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_TEXT.scrollback
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(n)))
}

/** Wrap a raw family name as a stack with a monospace fallback. */
export function customFontStack(family: string): string {
  // Strip any surrounding double quotes so callers can pass either a bare
  // family ("Fira Code") or an already-quoted one without producing a
  // malformed stack.
  const bare = family.trim().replace(/^"|"$/g, '').trim()
  if (bare.length === 0) return SYSTEM_FONT_STACK
  return `"${bare}", monospace`
}

/** Best-effort: pull the first family out of a stack, for display in the custom input. */
export function primaryFamily(stack: string): string {
  const quoted = stack.match(/^\s*"([^"]+)"/)
  if (quoted) return quoted[1]
  return stack.split(',')[0]?.trim() ?? ''
}

/** Read persisted prefs, falling back per-field to defaults on any problem. */
export function readStoredTerminalText(storage: TextPrefStorage): TerminalTextPref {
  const raw = storage.getItem(TERMINAL_TEXT_STORAGE_KEY)
  if (raw === null) return { ...DEFAULT_TERMINAL_TEXT }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_TERMINAL_TEXT }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...DEFAULT_TERMINAL_TEXT }
  }

  const obj = parsed as Record<string, unknown>
  return {
    fontFamily:
      typeof obj.fontFamily === 'string' && obj.fontFamily.trim().length > 0
        ? obj.fontFamily
        : DEFAULT_TERMINAL_TEXT.fontFamily,
    fontSize:
      typeof obj.fontSize === 'number'
        ? clampFontSize(obj.fontSize)
        : DEFAULT_TERMINAL_TEXT.fontSize,
    lineHeight:
      typeof obj.lineHeight === 'number'
        ? clampLineHeight(obj.lineHeight)
        : DEFAULT_TERMINAL_TEXT.lineHeight,
    ligatures:
      typeof obj.ligatures === 'boolean'
        ? obj.ligatures
        : DEFAULT_TERMINAL_TEXT.ligatures,
    wheelZoom: WHEEL_ZOOM_MODES.includes(obj.wheelZoom as WheelZoomMode)
      ? (obj.wheelZoom as WheelZoomMode)
      : DEFAULT_TERMINAL_TEXT.wheelZoom,
    scrollback:
      typeof obj.scrollback === 'number'
        ? clampScrollback(obj.scrollback)
        : DEFAULT_TERMINAL_TEXT.scrollback
  }
}

/** Persist prefs as JSON. */
export function storeTerminalText(storage: TextPrefStorage, pref: TerminalTextPref): void {
  storage.setItem(TERMINAL_TEXT_STORAGE_KEY, JSON.stringify(pref))
}

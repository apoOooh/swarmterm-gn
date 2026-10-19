import { describe, it, expect } from 'vitest'
import {
  MONO_FONTS,
  SYSTEM_FONT_STACK,
  DEFAULT_TERMINAL_TEXT,
  TERMINAL_TEXT_STORAGE_KEY,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_MAX,
  clampFontSize,
  clampLineHeight,
  clampScrollback,
  SCROLLBACK_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_CHOICES,
  customFontStack,
  primaryFamily,
  readStoredTerminalText,
  storeTerminalText,
  type TextPrefStorage,
  type TerminalTextPref
} from './terminal-text'

function fakeStorage(initial: Record<string, string> = {}): TextPrefStorage {
  const data: Record<string, string> = { ...initial }
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

describe('MONO_FONTS catalog', () => {
  it('every entry has a non-empty label and a stack ending in monospace', () => {
    for (const font of MONO_FONTS) {
      expect(font.label.length).toBeGreaterThan(0)
      expect(font.stack.trim().endsWith('monospace')).toBe(true)
    }
  })

  it('includes a System Default whose stack matches the historical default', () => {
    const system = MONO_FONTS.find((f) => f.id === 'system')
    expect(system?.stack).toBe(SYSTEM_FONT_STACK)
    expect(DEFAULT_TERMINAL_TEXT.fontFamily).toBe(SYSTEM_FONT_STACK)
  })

  it('marks at least the known ligature fonts as ligatures: true', () => {
    const ligatureIds = MONO_FONTS.filter((f) => f.ligatures).map((f) => f.id)
    expect(ligatureIds).toEqual(
      expect.arrayContaining(['cascadia-code', 'jetbrains-mono', 'fira-code'])
    )
  })
})

describe('DEFAULT_TERMINAL_TEXT', () => {
  it('reproduces the historical hardcoded rendering', () => {
    expect(DEFAULT_TERMINAL_TEXT).toEqual({
      fontFamily: SYSTEM_FONT_STACK,
      fontSize: 13,
      lineHeight: 1.0,
      ligatures: false,
      wheelZoom: 'pane',
      scrollback: 5000
    })
  })
})

describe('clampFontSize', () => {
  it('clamps below the min and above the max', () => {
    expect(clampFontSize(2)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(99)).toBe(FONT_SIZE_MAX)
  })
  it('rounds and passes through in-range values', () => {
    expect(clampFontSize(13)).toBe(13)
    expect(clampFontSize(14.6)).toBe(15)
  })
  it('falls back to the default for NaN', () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_TEXT.fontSize)
  })
})

describe('clampLineHeight', () => {
  it('clamps to the [min, max] band', () => {
    expect(clampLineHeight(0.5)).toBe(LINE_HEIGHT_MIN)
    expect(clampLineHeight(9)).toBe(LINE_HEIGHT_MAX)
  })
  it('rounds to one decimal place', () => {
    expect(clampLineHeight(1.2000001)).toBe(1.2)
  })
  it('falls back to the default for NaN', () => {
    expect(clampLineHeight(Number.NaN)).toBe(DEFAULT_TERMINAL_TEXT.lineHeight)
  })
})

describe('customFontStack / primaryFamily', () => {
  it('wraps a raw family with a monospace fallback', () => {
    expect(customFontStack('Comic Mono')).toBe('"Comic Mono", monospace')
  })
  it('falls back to the system stack for empty input', () => {
    expect(customFontStack('   ')).toBe(SYSTEM_FONT_STACK)
  })
  it('extracts the first family for display', () => {
    expect(primaryFamily('"Fira Code", monospace')).toBe('Fira Code')
    expect(primaryFamily('Menlo, monospace')).toBe('Menlo')
  })
  it('strips surrounding double quotes from the input', () => {
    expect(customFontStack('"Fira Code"')).toBe('"Fira Code", monospace')
  })
})

describe('readStoredTerminalText', () => {
  it('returns defaults when nothing is stored', () => {
    expect(readStoredTerminalText(fakeStorage())).toEqual(DEFAULT_TERMINAL_TEXT)
  })

  it('round-trips a valid stored value', () => {
    const pref: TerminalTextPref = {
      fontFamily: '"Fira Code", monospace',
      fontSize: 16,
      lineHeight: 1.4,
      ligatures: true,
      wheelZoom: 'global',
      scrollback: 20000
    }
    const storage = fakeStorage()
    storeTerminalText(storage, pref)
    expect(readStoredTerminalText(storage)).toEqual(pref)
  })

  it('returns defaults for corrupt JSON', () => {
    const storage = fakeStorage({ [TERMINAL_TEXT_STORAGE_KEY]: '{not json' })
    expect(readStoredTerminalText(storage)).toEqual(DEFAULT_TERMINAL_TEXT)
  })

  it('falls back per-field on a partial object', () => {
    const storage = fakeStorage({
      [TERMINAL_TEXT_STORAGE_KEY]: JSON.stringify({ fontSize: 20 })
    })
    expect(readStoredTerminalText(storage)).toEqual({
      ...DEFAULT_TERMINAL_TEXT,
      fontSize: 20
    })
  })

  it('clamps out-of-range numbers on read', () => {
    const storage = fakeStorage({
      [TERMINAL_TEXT_STORAGE_KEY]: JSON.stringify({ fontSize: 500, lineHeight: 0.1 })
    })
    const read = readStoredTerminalText(storage)
    expect(read.fontSize).toBe(FONT_SIZE_MAX)
    expect(read.lineHeight).toBe(LINE_HEIGHT_MIN)
  })

  it('defaults Ctrl+scroll zoom to the pane under the mouse', () => {
    expect(DEFAULT_TERMINAL_TEXT.wheelZoom).toBe('pane')
  })

  it('falls back to the default for an unknown wheel zoom mode', () => {
    const storage = fakeStorage({
      [TERMINAL_TEXT_STORAGE_KEY]: JSON.stringify({ wheelZoom: 'everything' })
    })
    expect(readStoredTerminalText(storage).wheelZoom).toBe('pane')
  })

  it('reads a stored wheel zoom mode', () => {
    const storage = fakeStorage({
      [TERMINAL_TEXT_STORAGE_KEY]: JSON.stringify({ wheelZoom: 'off' })
    })
    expect(readStoredTerminalText(storage).wheelZoom).toBe('off')
  })
})

describe('scrollback', () => {
  it('clamps to the [min, max] band and rounds', () => {
    expect(clampScrollback(10)).toBe(SCROLLBACK_MIN)
    expect(clampScrollback(1e9)).toBe(SCROLLBACK_MAX)
    expect(clampScrollback(1234.6)).toBe(1235)
    expect(clampScrollback(NaN)).toBe(5000)
  })

  it('reads, clamps and defaults the stored value', () => {
    const read = (v: unknown) =>
      readStoredTerminalText(fakeStorage({ [TERMINAL_TEXT_STORAGE_KEY]: JSON.stringify({ scrollback: v }) })).scrollback
    expect(read(20000)).toBe(20000)
    expect(read(1)).toBe(SCROLLBACK_MIN)
    expect(read('lots')).toBe(5000)
  })

  it('offers only in-range choices including the default', () => {
    expect(SCROLLBACK_CHOICES).toContain(5000)
    for (const n of SCROLLBACK_CHOICES) expect(clampScrollback(n)).toBe(n)
  })
})

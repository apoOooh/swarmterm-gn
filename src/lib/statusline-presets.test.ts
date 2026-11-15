import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEGMENTS,
  DEFAULT_STATUSLINE_SETTINGS,
  SEGMENTS,
  choiceOf,
  moveSlot,
  normalizeSlots,
  toggleSlot,
  clampVibrance,
  normalizeSettings,
  vibranceApplies
} from './statusline-presets'
import { codexCustomItems, codexPreviewLine } from './codex-statusline-preview'

describe('statusline presets', () => {
  it('maps the old switch: on = stored template, off = Off', () => {
    expect(choiceOf(true, DEFAULT_STATUSLINE_SETTINGS)).toBe('compact')
    expect(choiceOf(true, { ...DEFAULT_STATUSLINE_SETTINGS, claude: 'detailed' })).toBe('detailed')
    expect(choiceOf(false, { ...DEFAULT_STATUSLINE_SETTINGS, claude: 'detailed' })).toBe('off')
  })

  it('applies vibrance only where a hue can be scaled', () => {
    expect(vibranceApplies('subtle')).toBe(false)
    expect(vibranceApplies('high-contrast')).toBe(false)
    expect(vibranceApplies('app-theme')).toBe(true)
  })

  it('clamps vibrance', () => {
    expect(clampVibrance(-3)).toBe(0)
    expect(clampVibrance(140)).toBe(100)
    expect(clampVibrance(Number.NaN)).toBe(50)
    expect(clampVibrance(33.6)).toBe(34)
  })

  it('fills missing fields from defaults', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_STATUSLINE_SETTINGS)
    expect(normalizeSettings({ scheme: 'app-theme', vibrance: 900 })).toMatchObject({
      claude: 'compact',
      scheme: 'app-theme',
      vibrance: 100
    })
  })
})

describe('custom segments (SWA-93)', () => {
  it('normalizes: saved order, unknown and duplicate ids dropped, missing appended off', () => {
    const r = normalizeSlots(
      [
        { id: 'mcp', on: true },
        { id: 'future', on: true },
        { id: 'branch', on: true },
        { id: 'mcp', on: false }
      ],
      SEGMENTS.map((s) => s.id)
    )
    expect(r.slice(0, 2)).toEqual([
      { id: 'mcp', on: true },
      { id: 'branch', on: true }
    ])
    expect(r).toHaveLength(SEGMENTS.length)
    expect(r.slice(2).every((s) => !s.on)).toBe(true)
  })

  it('moves and toggles without touching the input', () => {
    const list = DEFAULT_SEGMENTS
    expect(moveSlot(list, 0, 1).map((s) => s.id).slice(0, 2)).toEqual(['effort', 'model'])
    expect(moveSlot(list, 0, -1)).toEqual(list)
    expect(toggleSlot(list, 2)[2].on).toBe(!list[2].on)
    expect(list).toEqual(DEFAULT_SEGMENTS)
  })

  it('old settings get the default list', () => {
    expect(normalizeSettings({ claude: 'extended' }).claudeSegments).toEqual(DEFAULT_SEGMENTS)
    expect(normalizeSettings({}).codexItems).toEqual([])
  })
})

describe('codex custom items (SWA-93)', () => {
  it('starts as Extended and keeps only tested ids', () => {
    expect(codexPreviewLine('custom', [])).toBe(codexPreviewLine('extended'))
    const items = codexCustomItems([
      { id: 'weekly-limit', on: true },
      { id: 'rm -rf', on: true }
    ])
    expect(items[0]).toEqual({ id: 'weekly-limit', on: true })
    expect(items.some((i) => i.id === 'rm -rf')).toBe(false)
    expect(codexPreviewLine('custom', items)).toBe('weekly 59%')
  })
})

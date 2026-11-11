import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STATUSLINE_SETTINGS,
  choiceOf,
  clampVibrance,
  normalizeSettings,
  vibranceApplies
} from './statusline-presets'

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

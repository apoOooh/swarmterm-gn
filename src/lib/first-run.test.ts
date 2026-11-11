import { describe, expect, it } from 'vitest'
import { BESTAND_KEYS, hasLocalHistory, wizardOnBoot } from './first-run'

const storage = (entries: Record<string, string>): Pick<Storage, 'getItem'> => ({
  getItem: (k) => (k in entries ? entries[k] : null)
})

describe('hasLocalHistory', () => {
  it('counts recents, saved workspaces and a chosen appearance as an older install', () => {
    expect(hasLocalHistory(storage({}))).toBe(false)
    for (const key of BESTAND_KEYS) {
      expect(hasLocalHistory(storage({ [key]: '["x"]' })), key).toBe(true)
    }
  })

  it('ignores empty lists and blank values', () => {
    expect(hasLocalHistory(storage({ 'cc-recent-folders': '[]', 'swarmterm-saved-workspaces': '' }))).toBe(false)
  })

  it('reads a throwing storage as no history', () => {
    expect(hasLocalHistory({ getItem: () => { throw new Error('blocked') } })).toBe(false)
  })
})

describe('wizardOnBoot', () => {
  it('shows the assistant only for a pending new install without local history', () => {
    expect(wizardOnBoot('pending', false)).toEqual({ show: true, report: null })
    expect(wizardOnBoot('pending', true)).toEqual({ show: false, report: 'existing' })
    for (const state of ['done', 'skipped', 'existing'] as const) {
      expect(wizardOnBoot(state, false)).toEqual({ show: false, report: null })
    }
  })

  it('never shows it when Rust could not answer', () => {
    expect(wizardOnBoot(null, false)).toEqual({ show: false, report: null })
  })
})

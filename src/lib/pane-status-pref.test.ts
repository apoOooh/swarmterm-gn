import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PANE_STATUS_PREFS,
  PANE_STATUS_PREF_STORAGE_KEY,
  readStoredPaneStatusPrefs,
  storePaneStatusPrefs,
  type PaneStatusPrefStorage
} from './pane-status-pref'

function fakeStorage(initial: Record<string, string> = {}): PaneStatusPrefStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

describe('readStoredPaneStatusPrefs', () => {
  it('defaults to on with a 10-minute gradient', () => {
    expect(readStoredPaneStatusPrefs(fakeStorage())).toEqual({ enabled: true, gradientMinutes: 10 })
  })

  it('round-trips a stored choice', () => {
    const storage = fakeStorage()
    storePaneStatusPrefs(storage, { enabled: true, gradientMinutes: 30 })
    expect(readStoredPaneStatusPrefs(storage)).toEqual({ enabled: true, gradientMinutes: 30 })
  })

  it('falls back to defaults on broken JSON or a non-object', () => {
    expect(readStoredPaneStatusPrefs(fakeStorage({ [PANE_STATUS_PREF_STORAGE_KEY]: '{' }))).toEqual(
      DEFAULT_PANE_STATUS_PREFS
    )
    expect(readStoredPaneStatusPrefs(fakeStorage({ [PANE_STATUS_PREF_STORAGE_KEY]: '7' }))).toEqual(
      DEFAULT_PANE_STATUS_PREFS
    )
  })

  it('falls back per field, keeping the valid one', () => {
    const storage = fakeStorage({
      [PANE_STATUS_PREF_STORAGE_KEY]: JSON.stringify({ enabled: true, gradientMinutes: 7 })
    })
    expect(readStoredPaneStatusPrefs(storage)).toEqual({ enabled: true, gradientMinutes: 10 })
  })

  it('accepts 0 as "no gradient"', () => {
    const storage = fakeStorage({
      [PANE_STATUS_PREF_STORAGE_KEY]: JSON.stringify({ enabled: 'yes', gradientMinutes: 0 })
    })
    expect(readStoredPaneStatusPrefs(storage)).toEqual({ enabled: true, gradientMinutes: 0 })
  })
})

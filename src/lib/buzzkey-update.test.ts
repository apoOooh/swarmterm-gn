import { describe, expect, it } from 'vitest'
import {
  AUTO_RETRY_MS,
  DEFAULT_BUZZKEY_UPDATE_PREFS,
  UPDATE_CHECK_INTERVAL_MS,
  afterAutoFailure,
  afterCheck,
  decideUpdate,
  readStoredBuzzkeyUpdatePrefs,
  shouldCheck,
  storeBuzzkeyUpdatePrefs,
  type CheckSchedule,
  type UpdateFacts
} from './buzzkey-update'

const check: UpdateFacts = {
  latestVersion: '1.9.6+bk.1',
  currentVersion: '1.9.1+bk.5',
  updateAvailable: true,
  majorJump: false
}
const prefs = DEFAULT_BUZZKEY_UPDATE_PREFS

describe('decideUpdate', () => {
  it('shows a toast for a newer release by default (auto-update is off)', () => {
    expect(prefs.autoUpdate).toBe(false)
    expect(decideUpdate(check, prefs)).toEqual({ kind: 'toast', version: '1.9.6+bk.1', majorJump: false })
  })

  it('stays quiet without an update, a known installed version or a release', () => {
    expect(decideUpdate({ ...check, updateAvailable: false }, prefs)).toEqual({ kind: 'none' })
    // Unknown current version: the check counts any release as available
    // (fresh install) — that is not an update to announce.
    expect(decideUpdate({ ...check, currentVersion: null }, prefs)).toEqual({ kind: 'none' })
    expect(decideUpdate({ ...check, latestVersion: null }, prefs)).toEqual({ kind: 'none' })
  })

  it('a declined version stays quiet until the next version', () => {
    const declined = { ...prefs, declinedVersion: '1.9.6+bk.1' }
    expect(decideUpdate(check, declined)).toEqual({ kind: 'none' })
    expect(decideUpdate({ ...check, latestVersion: '1.9.6+bk.2' }, declined).kind).toBe('toast')
  })

  it('updates automatically only when opted in and not a major jump', () => {
    const auto = { ...prefs, autoUpdate: true }
    expect(decideUpdate(check, auto)).toEqual({ kind: 'auto', version: '1.9.6+bk.1' })
    expect(decideUpdate({ ...check, majorJump: true, latestVersion: '2.0.0+bk.1' }, auto)).toEqual({
      kind: 'toast',
      version: '2.0.0+bk.1',
      majorJump: true
    })
  })

  it('asks for a major jump once: declining it silences that version even with auto on', () => {
    const auto = { autoUpdate: true, declinedVersion: '2.0.0+bk.1' }
    expect(decideUpdate({ ...check, majorJump: true, latestVersion: '2.0.0+bk.1' }, auto)).toEqual({ kind: 'none' })
  })
})

describe('shouldCheck', () => {
  const ready = { installed: true, currentVersion: '1.9.1+bk.5', whisperKeyRunning: false, busy: false }
  const fresh: CheckSchedule = { nextAt: 0, checkedFor: null }

  it('needs an installed, connected buzzkey and no install in flight', () => {
    expect(shouldCheck(1000, fresh, ready)).toBe(true)
    expect(shouldCheck(1000, fresh, { ...ready, installed: false })).toBe(false)
    expect(shouldCheck(1000, fresh, { ...ready, currentVersion: null })).toBe(false)
    expect(shouldCheck(1000, fresh, { ...ready, whisperKeyRunning: true })).toBe(false)
    expect(shouldCheck(1000, fresh, { ...ready, busy: true })).toBe(false)
  })

  it('checks every 24 h, and again when buzzkey reports another version', () => {
    const done = afterCheck(1000, '1.9.1+bk.5')
    expect(done.nextAt).toBe(1000 + UPDATE_CHECK_INTERVAL_MS)
    expect(shouldCheck(2000, done, ready)).toBe(false)
    expect(shouldCheck(1000 + UPDATE_CHECK_INTERVAL_MS, done, ready)).toBe(true)
    expect(shouldCheck(2000, done, { ...ready, currentVersion: '1.9.6+bk.1' })).toBe(true)
  })

  it('a dictation postpones an automatic update by a minute, nothing else does', () => {
    const done = afterCheck(1000, '1.9.1+bk.5')
    expect(afterAutoFailure(5000, done, 'dictating').nextAt).toBe(5000 + AUTO_RETRY_MS)
    expect(afterAutoFailure(5000, done, 'signature-invalid')).toBe(done)
  })
})

describe('stored prefs', () => {
  const memory = (): Storage => {
    const m = new Map<string, string>()
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      key: () => null,
      get length() {
        return m.size
      }
    }
  }

  it('round-trips and falls back to the defaults on garbage', () => {
    const s = memory()
    expect(readStoredBuzzkeyUpdatePrefs(s)).toEqual(DEFAULT_BUZZKEY_UPDATE_PREFS)
    storeBuzzkeyUpdatePrefs(s, { autoUpdate: true, declinedVersion: '1.9.6+bk.1' })
    expect(readStoredBuzzkeyUpdatePrefs(s)).toEqual({ autoUpdate: true, declinedVersion: '1.9.6+bk.1' })
    s.setItem('swarmterm.buzzkeyUpdate', '{"autoUpdate":"yes","declinedVersion":4}')
    expect(readStoredBuzzkeyUpdatePrefs(s)).toEqual(DEFAULT_BUZZKEY_UPDATE_PREFS)
    s.setItem('swarmterm.buzzkeyUpdate', 'not json')
    expect(readStoredBuzzkeyUpdatePrefs(s)).toEqual(DEFAULT_BUZZKEY_UPDATE_PREFS)
  })
})

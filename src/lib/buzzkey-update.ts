/**
 * buzzkey update toast: when to look for a new signed buzzkey release and
 * what to do with one. Rust (`voice/companion/`) does the fetching, the
 * signature-first verification and the install; these rules decide whether
 * the user sees a toast, gets an automatic update, or hears nothing.
 *
 *  - Only an installed, connected buzzkey counts: without the version from
 *    its `hello` there is nothing to compare, and a missing buzzkey is not
 *    "an update" (Settings offers the install).
 *  - "Later" remembers the version; the toast returns with the next one.
 *  - "Update automatically" is opt-in and never covers a major jump — that
 *    is asked once, and declining it silences that version like "Later".
 *  - Fail-open: a failed check is silent and simply retried on schedule.
 */

export interface BuzzkeyUpdatePrefs {
  autoUpdate: boolean
  /** The version the user said "Later" to. */
  declinedVersion: string | null
}

export const DEFAULT_BUZZKEY_UPDATE_PREFS: BuzzkeyUpdatePrefs = { autoUpdate: false, declinedVersion: null }

/** Not at boot: pty spawns and buzzkey's own autostart go first. */
export const UPDATE_CHECK_DELAY_MS = 20_000
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Cheap local status poll: notices a buzzkey that connects (or comes back
 * updated) after boot without waiting a day. */
export const UPDATE_POLL_MS = 30_000
/** An automatic update refused because of a dictation tries again after this. */
export const AUTO_RETRY_MS = 60_000

/** The part of Rust's `UpdateCheck` the decision needs. */
export interface UpdateFacts {
  latestVersion: string | null
  currentVersion: string | null
  updateAvailable: boolean
  majorJump: boolean
}

export type UpdateDecision =
  | { kind: 'none' }
  | { kind: 'toast'; version: string; majorJump: boolean }
  | { kind: 'auto'; version: string }

export function decideUpdate(check: UpdateFacts, prefs: BuzzkeyUpdatePrefs): UpdateDecision {
  const version = check.latestVersion
  if (!check.updateAvailable || version === null || check.currentVersion === null) return { kind: 'none' }
  if (prefs.declinedVersion === version) return { kind: 'none' }
  if (prefs.autoUpdate && !check.majorJump) return { kind: 'auto', version }
  return { kind: 'toast', version, majorJump: check.majorJump }
}

export interface CheckSchedule {
  /** Epoch ms of the next due check. */
  nextAt: number
  /** The buzzkey version the last check compared against. */
  checkedFor: string | null
}

export interface CompanionFacts {
  installed: boolean
  currentVersion: string | null
  whisperKeyRunning: boolean
  busy: boolean
}

export function shouldCheck(now: number, schedule: CheckSchedule, s: CompanionFacts): boolean {
  if (!s.installed || s.currentVersion === null || s.whisperKeyRunning || s.busy) return false
  return now >= schedule.nextAt || s.currentVersion !== schedule.checkedFor
}

export function afterCheck(now: number, currentVersion: string | null): CheckSchedule {
  return { nextAt: now + UPDATE_CHECK_INTERVAL_MS, checkedFor: currentVersion }
}

/** Only "a dictation is running" is worth a quick retry; anything else
 * (bad signature, network) waits for the regular schedule. */
export function afterAutoFailure(now: number, schedule: CheckSchedule, reason: string): CheckSchedule {
  return reason === 'dictating' ? { ...schedule, nextAt: now + AUTO_RETRY_MS } : schedule
}

const KEY = 'swarmterm.buzzkeyUpdate'

export function readStoredBuzzkeyUpdatePrefs(storage: Storage): BuzzkeyUpdatePrefs {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? 'null')
    if (raw && typeof raw === 'object') {
      const { autoUpdate, declinedVersion } = raw as Record<string, unknown>
      if (typeof autoUpdate === 'boolean' && (declinedVersion === null || typeof declinedVersion === 'string')) {
        return { autoUpdate, declinedVersion }
      }
    }
  } catch {
    // Corrupt entry: defaults.
  }
  return DEFAULT_BUZZKEY_UPDATE_PREFS
}

export function storeBuzzkeyUpdatePrefs(storage: Storage, prefs: BuzzkeyUpdatePrefs): void {
  storage.setItem(KEY, JSON.stringify(prefs))
}

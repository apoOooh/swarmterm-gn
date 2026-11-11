/**
 * First start (SWA-83 phase 2). Rust decides from named marker files in the
 * app data dir whether this is a new installation (`first_run.rs`); the
 * renderer adds what only it can see: localStorage from an older install
 * (recents, saved workspaces, a chosen appearance). Those keys are written
 * by user actions only, never by a boot default, so a fresh profile has none.
 */
import { APPEARANCE_STORAGE_KEY } from './appearance'
import { RECENTS_STORAGE_KEY } from './recent-folders'
import { SAVED_WORKSPACES_KEY } from './saved-workspaces'

export type WizardState = 'pending' | 'done' | 'skipped' | 'existing'
export type WizardOutcome = Exclude<WizardState, 'pending'>

export const BESTAND_KEYS = [RECENTS_STORAGE_KEY, SAVED_WORKSPACES_KEY, APPEARANCE_STORAGE_KEY] as const

export function hasLocalHistory(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return BESTAND_KEYS.some((key) => {
      const raw = storage.getItem(key)?.trim() ?? ''
      return raw !== '' && raw !== '[]' && raw !== '{}'
    })
  } catch {
    return false
  }
}

/**
 * What to do at boot. A pending state with local history is an install from
 * before the assistant whose app data held no marker yet: report it as
 * `existing` (Rust then keeps voice on) instead of greeting the user anew.
 * No answer from Rust = no assistant: it must never block a working app.
 */
export function wizardOnBoot(state: WizardState | null, localHistory: boolean): { show: boolean; report: WizardOutcome | null } {
  if (state !== 'pending') return { show: false, report: null }
  if (localHistory) return { show: false, report: 'existing' }
  return { show: true, report: null }
}

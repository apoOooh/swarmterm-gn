import { create } from 'zustand'
import {
  DEFAULT_BUZZKEY_UPDATE_PREFS,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_POLL_MS,
  afterAutoFailure,
  afterCheck,
  decideUpdate,
  readStoredBuzzkeyUpdatePrefs,
  shouldCheck,
  storeBuzzkeyUpdatePrefs,
  type BuzzkeyUpdatePrefs,
  type CheckSchedule
} from '@/lib/buzzkey-update'
import { companionErrorText } from '@/lib/voice-companion'
import { checkCompanionUpdate, getCompanionStatus, installCompanion } from '@/tauri/voice-companion'

export interface BuzzkeyToast {
  version: string
  majorJump: boolean
  installing: boolean
  error: string | null
}

export interface BuzzkeyUpdateStore {
  prefs: BuzzkeyUpdatePrefs
  toast: BuzzkeyToast | null
  setAutoUpdate: (on: boolean) => void
  /** "Later": remember the version, hide until the next one. */
  decline: () => void
  updateNow: () => Promise<void>
  /** Start/24 h checks; returns the cleanup. */
  startWatch: () => () => void
}

/**
 * buzzkey update toast (rules in `lib/buzzkey-update.ts`). Prefs live in
 * localStorage — renderer-only, like the notification prefs; Rust only
 * learns about them through the `unattended` flag of one install call.
 */
export const useBuzzkeyUpdateStore = create<BuzzkeyUpdateStore>((set, get) => {
  const initial =
    typeof window === 'undefined' ? DEFAULT_BUZZKEY_UPDATE_PREFS : readStoredBuzzkeyUpdatePrefs(window.localStorage)
  const apply = (prefs: BuzzkeyUpdatePrefs): void => {
    storeBuzzkeyUpdatePrefs(window.localStorage, prefs)
    set({ prefs })
  }
  let schedule: CheckSchedule = { nextAt: 0, checkedFor: null }
  let running = false

  const tick = async (): Promise<void> => {
    if (running || get().toast?.installing) return
    running = true
    try {
      const s = await getCompanionStatus()
      const now = Date.now()
      const facts = {
        installed: s.installed,
        currentVersion: s.connected ? s.version : null,
        whisperKeyRunning: s.whisperKeyRunning,
        busy: s.busy
      }
      if (!shouldCheck(now, schedule, facts)) return
      const check = await checkCompanionUpdate()
      schedule = afterCheck(now, facts.currentVersion)
      const decision = decideUpdate(check, get().prefs)
      if (decision.kind === 'none') {
        // A newer buzzkey than the toast offers (updated elsewhere) ends it.
        if (get().toast && !check.updateAvailable) set({ toast: null })
        return
      }
      if (decision.kind === 'toast') {
        if (get().toast?.version !== decision.version) {
          set({ toast: { version: decision.version, majorJump: decision.majorJump, installing: false, error: null } })
        }
        return
      }
      try {
        await installCompanion(true)
        set({ toast: null })
      } catch (e) {
        const reason = String(e)
        schedule = afterAutoFailure(Date.now(), schedule, reason)
        // A dictation just postpones it; a real failure surfaces as the toast.
        if (reason !== 'dictating') {
          set({ toast: { version: decision.version, majorJump: false, installing: false, error: companionErrorText(reason) } })
        }
      }
    } catch {
      // Fail-open: network or status errors never show anything.
    } finally {
      running = false
    }
  }

  return {
    prefs: initial,
    toast: null,
    setAutoUpdate: (on) => apply({ ...get().prefs, autoUpdate: on }),
    decline: () => {
      const toast = get().toast
      if (!toast || toast.installing) return
      apply({ ...get().prefs, declinedVersion: toast.version })
      set({ toast: null })
    },
    updateNow: async () => {
      const toast = get().toast
      if (!toast || toast.installing) return
      set({ toast: { ...toast, installing: true, error: null } })
      try {
        await installCompanion(false)
        set({ toast: null })
        // Re-check against the restarted buzzkey's version on the next tick.
        schedule = { nextAt: 0, checkedFor: null }
      } catch (e) {
        set({ toast: { ...toast, installing: false, error: companionErrorText(String(e)) } })
      }
    },
    startWatch: () => {
      let poll: number | undefined
      const first = window.setTimeout(() => {
        void tick()
        poll = window.setInterval(() => void tick(), UPDATE_POLL_MS)
      }, UPDATE_CHECK_DELAY_MS)
      return () => {
        window.clearTimeout(first)
        if (poll !== undefined) window.clearInterval(poll)
      }
    }
  }
})

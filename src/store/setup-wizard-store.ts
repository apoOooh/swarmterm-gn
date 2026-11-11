import { create } from 'zustand'
import { hasLocalHistory, wizardOnBoot, type WizardOutcome } from '@/lib/first-run'
import { finishSetupWizard, getSetupWizardState } from '@/tauri/setup'

/**
 * The setup assistant's visibility (SWA-83 phase 2). `boot` runs once per
 * process: it opens the assistant for a new install, or tells Rust that
 * localStorage shows an older one. Settings → Setup can open it again at
 * any time (`origin: 'settings'`); closing a re-run only stores a new
 * outcome when the user finishes or skips it.
 */
interface SetupWizardState {
  open: boolean
  origin: 'first-run' | 'settings'
  boot: () => Promise<void>
  openAgain: () => void
  finish: (outcome: Exclude<WizardOutcome, 'existing'>) => Promise<void>
  close: () => void
}

let booted = false

export const useSetupWizardStore = create<SetupWizardState>((set) => ({
  open: false,
  origin: 'first-run',
  boot: async () => {
    if (booted) return
    booted = true
    let state = null
    try {
      state = await getSetupWizardState()
    } catch (e) {
      console.warn('setup wizard: state unavailable', e)
    }
    let local = false
    try { local = hasLocalHistory(window.localStorage) } catch { local = false }
    const decision = wizardOnBoot(state, local)
    if (decision.report !== null) {
      void finishSetupWizard(decision.report).catch((e) => console.warn('setup wizard: report failed', e))
    }
    if (decision.show) set({ open: true, origin: 'first-run' })
  },
  openAgain: () => set({ open: true, origin: 'settings' }),
  finish: async (outcome) => {
    set({ open: false })
    try {
      await finishSetupWizard(outcome)
    } catch (e) {
      console.warn('setup wizard: finish failed', e)
    }
  },
  close: () => set({ open: false })
}))

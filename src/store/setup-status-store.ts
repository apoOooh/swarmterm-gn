import { create } from 'zustand'
import { getSetupStatus, recheckSetup } from '@/tauri/setup'
import type { SetupStatus } from '@/lib/setup-status'

/**
 * Agent integration status for Settings → Setup and the bell (SWA-83).
 * `null` until the first answer. `load` only reads; `recheck` re-runs the
 * Rust checks (Welcome mount, the Settings button) so a CLI installed while
 * the app runs is set up without a restart.
 */
interface SetupStatusState {
  status: SetupStatus | null
  checking: boolean
  load: () => Promise<void>
  recheck: () => Promise<void>
}

export const useSetupStatusStore = create<SetupStatusState>((set, get) => ({
  status: null,
  checking: false,
  load: async () => {
    try {
      set({ status: await getSetupStatus() })
    } catch (e) {
      console.warn('setup: status unavailable', e)
    }
  },
  recheck: async () => {
    if (get().checking) return
    set({ checking: true })
    try {
      set({ status: await recheckSetup() })
    } catch (e) {
      console.warn('setup: recheck failed', e)
    } finally {
      set({ checking: false })
    }
  }
}))

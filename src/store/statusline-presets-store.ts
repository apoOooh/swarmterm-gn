import { create } from 'zustand'
import {
  DEFAULT_STATUSLINE_SETTINGS,
  normalizeSettings,
  type Choice,
  type StatuslineSettings
} from '@/lib/statusline-presets'
import { getStatuslineSettings, setStatuslineSettings } from '@/tauri/statusline-presets'
import { useStatuslineStore } from './statusline-store'

interface StatuslinePresetsStore {
  settings: StatuslineSettings
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<StatuslineSettings>) => Promise<void>
  /** Off removes our entry via the old switch; a template turns it on. */
  choose: (choice: Choice) => Promise<void>
}

export const useStatuslinePresetsStore = create<StatuslinePresetsStore>((set, get) => ({
  settings: DEFAULT_STATUSLINE_SETTINGS,
  loaded: false,
  load: async () => {
    const raw = await getStatuslineSettings().catch(() => null)
    set({ settings: normalizeSettings(raw), loaded: true })
  },
  update: async (patch) => {
    const settings = normalizeSettings({ ...get().settings, ...patch })
    set({ settings })
    await setStatuslineSettings(settings).catch((e) =>
      console.warn('statusline: could not save settings', e)
    )
  },
  choose: async (choice) => {
    const statusline = useStatuslineStore.getState()
    if (choice === 'off') {
      await statusline.setEnabled(false)
      return
    }
    await get().update({ claude: choice })
    if (!statusline.enabled) await statusline.setEnabled(true)
  }
}))

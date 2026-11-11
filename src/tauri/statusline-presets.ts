import { invoke } from '@tauri-apps/api/core'
import type { StatuslineSettings } from '@/lib/statusline-presets'

/** Saved template, scheme, vibrance and animation (`statusline.json`). */
export const getStatuslineSettings = (): Promise<Partial<StatuslineSettings>> =>
  invoke('statusline_settings_get')

/** Store them; Claude panes pick them up on their next status line render. */
export const setStatuslineSettings = (settings: StatuslineSettings): Promise<void> =>
  invoke('statusline_settings_set', { settings })

/** Example rows (ANSI) from the real renderer at `columns` terminal columns. */
export const previewStatusline = (settings: StatuslineSettings, columns: number): Promise<string[]> =>
  invoke('statusline_preview', { settings, columns })

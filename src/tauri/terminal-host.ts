import { invoke } from '@tauri-apps/api/core'

/** Settings → Terminal → terminal host (SWA-55, ADR 0001), persisted in Rust. */
export interface TerminalHostSettings {
  enabled: boolean
}

export interface TerminalHostStatus {
  enabled: boolean
  /** False off Windows: the host is Windows-only like the fork. */
  supported: boolean
  connected: boolean
  hostVersion: string | null
  /** Why the last pane fell back to in-process, if it did. */
  error: string | null
}

export const getTerminalHostSettings = (): Promise<TerminalHostSettings> =>
  invoke('terminal_host_get_settings')

export const setTerminalHostSettings = (settings: TerminalHostSettings): Promise<TerminalHostSettings> =>
  invoke('terminal_host_set_settings', { settings })

export const getTerminalHostStatus = (): Promise<TerminalHostStatus> => invoke('terminal_host_status')

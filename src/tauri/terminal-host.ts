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
  /** Set when the running host predates process priority (ADR 0005): new panes then run in-process. */
  priorityUnsupported: string | null
}

export const getTerminalHostSettings = (): Promise<TerminalHostSettings> =>
  invoke('terminal_host_get_settings')

export const setTerminalHostSettings = (settings: TerminalHostSettings): Promise<TerminalHostSettings> =>
  invoke('terminal_host_set_settings', { settings })

export const getTerminalHostStatus = (): Promise<TerminalHostStatus> => invoke('terminal_host_status')

/** A pane that survived the last app instance in the host (SWA-56). */
export interface DetachedPane {
  terminalId: string
  spawnId: string
  pid: number | null
  cwd: string
  /** What the app sent with `create`: agentId, worktreeMode, repoRoot, … */
  meta: { agentId?: string | null } | null
}

/** Empty when the host is off, not running, or nothing survived. */
export const getDetachedPanes = (): Promise<DetachedPane[]> => invoke('terminal_host_detached')

/** Every pane id the saved workspaces reference; the host closes the rest. */
export const keepDetachedPanes = (ids: string[]): Promise<void> => invoke('terminal_host_keep', { ids })

/** Close the detached panes of a forgotten workspace. */
export const releaseDetachedPanes = (ids: string[]): Promise<void> =>
  invoke('terminal_host_release', { ids })

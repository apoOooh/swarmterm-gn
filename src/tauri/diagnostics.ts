import { invoke } from '@tauri-apps/api/core'

/** Settings → Terminal → Diagnostics (SWA-85), persisted in Rust (`diagnostics.rs`). */
export interface DiagnosticsView {
  /** Write a local dump when the window hangs (in effect: saved choice and no lock). */
  hangDumps: boolean
  /** `DisableHangDumps` (admin policy or Corp edition) forces dumps off. */
  locked: boolean
  /** Folder of `ui-stalls.log` and the dumps. */
  folder: string | null
}

export const getDiagnostics = (): Promise<DiagnosticsView> => invoke('diagnostics_get')

export const setHangDumps = (hangDumps: boolean): Promise<DiagnosticsView> =>
  invoke('diagnostics_set', { hangDumps })

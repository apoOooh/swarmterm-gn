import { invoke } from '@tauri-apps/api/core'

/** Append JSON lines to the dev log (no-op unless a dev build runs with SWARMTERM_DEV_LOG). */
export const writeDevLog = (lines: string[]): Promise<void> => invoke('dev_log', { lines })

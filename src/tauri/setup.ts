import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { SetupStatus } from '@/lib/setup-status'

/** Last outcome of each agent integration; never probes or writes. */
export const getSetupStatus = (): Promise<SetupStatus> => invoke('setup_status')

/** Re-run the checks (installs entries for a CLI that appeared since boot). */
export const recheckSetup = (): Promise<SetupStatus> => invoke('setup_recheck')

/** Rust changed a check (boot worker, pane spawn, status line switch). */
export const onSetupChanged = (cb: () => void): Promise<() => void> => listen('setup:changed', () => cb())

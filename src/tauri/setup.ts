import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { SetupStatus } from '@/lib/setup-status'
import type { WizardOutcome, WizardState } from '@/lib/first-run'

/** Last outcome of each agent integration; never probes or writes. */
export const getSetupStatus = (): Promise<SetupStatus> => invoke('setup_status')

/** Re-run the checks (installs entries for a CLI that appeared since boot). */
export const recheckSetup = (): Promise<SetupStatus> => invoke('setup_recheck')

/** Rust changed a check (boot worker, pane spawn, status line switch). */
export const onSetupChanged = (cb: () => void): Promise<() => void> => listen('setup:changed', () => cb())

/** First start (SWA-83 phase 2): `pending` = new install, assistant not finished. */
export const getSetupWizardState = (): Promise<WizardState> => invoke('setup_wizard_state')

/** Report how the assistant ended; Rust stores it and settles voice for a new install. */
export const finishSetupWizard = (outcome: WizardOutcome): Promise<WizardState> => invoke('setup_wizard_finish', { outcome })

/** Names (never values) of the API key variables set in Swarmterm's environment. */
export const getApiKeyVars = (): Promise<string[]> => invoke('setup_api_key_vars')

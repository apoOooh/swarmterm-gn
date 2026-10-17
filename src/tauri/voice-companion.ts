import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { CompanionProgress, CompanionStatus } from '@/lib/voice-companion'

/**
 * buzzkey companion bridge (SWA-42): install, start, quit and update buzzkey
 * from Settings → Voice. Every download is a click, except the opt-in
 * automatic update from the update toast (`unattended`, refused by Rust
 * while a dictation runs). Serde camelCase in lockstep with `src-tauri/src/voice/companion/`.
 */

export interface UpdateCheck {
  latestTag: string | null
  latestVersion: string | null
  updateAvailable: boolean
  currentVersion: string | null
  majorJump: boolean
}

export interface HardwareProbe {
  summary: string | null
  model: string | null
  runtime: string | null
  voiceAdvised: boolean | null
}

export const getCompanionStatus = (): Promise<CompanionStatus> => invoke('voice_companion_status')

export const checkCompanionUpdate = (): Promise<UpdateCheck> => invoke('voice_companion_check')

export const installCompanion = (unattended = false): Promise<CompanionStatus> =>
  invoke('voice_companion_install', { unattended })

export const startCompanion = (): Promise<CompanionStatus> => invoke('voice_companion_start')

export const quitCompanion = (): Promise<void> => invoke('voice_companion_quit')

export const setCompanionAutostart = (on: boolean): Promise<CompanionStatus> =>
  invoke('voice_companion_set_autostart', { on })

/** buzzkey's own read-only hardware check; null when it has none. */
export const probeCompanionHardware = (): Promise<HardwareProbe | null> => invoke('voice_companion_probe')

export const onCompanionProgress = (cb: (p: CompanionProgress) => void): Promise<UnlistenFn> =>
  listen<CompanionProgress>('voice:companion-progress', (e) => cb(e.payload))

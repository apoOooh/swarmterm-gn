import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * Voice dictation bridge (SWA-12). Rust owns the Buzzkey pipe and the pins;
 * it asks the renderer who owns the keyboard (`voice:focus-request`) and
 * hands it pinned text to write (`voice:insert`). Both answers go back by
 * requestId. Serde camelCase in lockstep with `src-tauri/src/voice/mod.rs`.
 */

export interface VoiceSettings {
  enabled: boolean
  allowAutoEnter: boolean
}

export interface FocusReply {
  terminalId: string | null
  name: string | null
  agentId: string | null
}

export interface VoiceInsertEvent {
  requestId: string
  terminalId: string
  expectedSpawnId: string
  text: string
  submit: boolean
}

export interface InsertReply {
  ok: boolean
  reason?: string
  submitScheduled?: boolean
}

export const onVoiceFocusRequest = (cb: (requestId: string) => void): Promise<UnlistenFn> =>
  listen<{ requestId: string }>('voice:focus-request', (e) => cb(e.payload.requestId))

export const onVoiceInsert = (cb: (e: VoiceInsertEvent) => void): Promise<UnlistenFn> =>
  listen<VoiceInsertEvent>('voice:insert', (e) => cb(e.payload))

export const voiceFocusResponse = (requestId: string, reply: FocusReply): Promise<void> =>
  invoke('voice_focus_response', { requestId, reply })

export const voiceInsertResult = (requestId: string, reply: InsertReply): Promise<void> =>
  invoke('voice_insert_result', { requestId, reply })

export const getVoiceSettings = (): Promise<VoiceSettings> => invoke('voice_get_settings')

export const setVoiceSettings = (settings: VoiceSettings): Promise<VoiceSettings> =>
  invoke('voice_set_settings', { settings })

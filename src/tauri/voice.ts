import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { IndicatorEvent } from '@/lib/voice-indicator'
import type { DictationEvent, DictationPhase, ModelStatus } from '@/lib/voice-dictation'
import type { TurnEvent } from '@/lib/voice-turns'

/**
 * Voice dictation bridge (SWA-12). Rust owns the buzzkey pipe and the pins;
 * it asks the renderer who owns the keyboard (`voice:focus-request`) and
 * hands it pinned text to write (`voice:insert`). Both answers go back by
 * requestId. Serde camelCase in lockstep with `src-tauri/src/voice/mod.rs`.
 */

export interface VoiceSettings {
  enabled: boolean
  allowAutoEnter: boolean
  announceTurns: boolean
  /** Built-in speech source (SWA-38). */
  builtinEnabled: boolean
  model: string
  /** Whisper language code or `auto`. */
  language: string
}

export interface SpeechStatus {
  models: ModelStatus[]
  dictation: DictationPhase
}

export interface ModelProgress {
  id: string
  received: number
  total: number
  done: boolean
  error?: string
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

/** "Listening" pill on/off for a pinned pane (SWA-40). */
export const onVoiceIndicator = (cb: (e: IndicatorEvent) => void): Promise<UnlistenFn> =>
  listen<IndicatorEvent>('voice:indicator', (e) => cb(e.payload))

/** The pill's Stop: drops the pin and tells the dictation app to discard. */
export const voiceIndicatorStop = (pin: string): Promise<void> =>
  invoke('voice_indicator_stop', { pin })

export const voiceFocusResponse = (requestId: string, reply: FocusReply): Promise<void> =>
  invoke('voice_focus_response', { requestId, reply })

export const voiceInsertResult = (requestId: string, reply: InsertReply): Promise<void> =>
  invoke('voice_insert_result', { requestId, reply })

export const getVoiceSettings = (): Promise<VoiceSettings> => invoke('voice_get_settings')

export const setVoiceSettings = (settings: VoiceSettings): Promise<VoiceSettings> =>
  invoke('voice_set_settings', { settings })

/** Agent finished / needs input (SWA-41); Rust drops it unless announcing is on. */
export const voiceTurnEvent = (event: TurnEvent): Promise<void> => invoke('voice_turn_event', { event })

// Built-in speech source (SWA-38): Rust records and transcribes, then types
// through the same `voice:insert` path as buzzkey.

/** Start when idle, stop + transcribe when recording. Rejects with a reason. */
export const voiceDictationToggle = (): Promise<void> => invoke('voice_dictation_toggle')

export const voiceDictationCancel = (): Promise<void> => invoke('voice_dictation_cancel')

export const onVoiceDictation = (cb: (e: DictationEvent) => void): Promise<UnlistenFn> =>
  listen<DictationEvent>('voice:dictation', (e) => cb(e.payload))

export const getSpeechStatus = (): Promise<SpeechStatus> => invoke('voice_speech_status')

export const downloadVoiceModel = (id: string): Promise<void> => invoke('voice_model_download', { id })

export const cancelVoiceModel = (id: string): Promise<void> => invoke('voice_model_cancel', { id })

export const deleteVoiceModel = (id: string): Promise<void> => invoke('voice_model_delete', { id })

export const onVoiceModelProgress = (cb: (e: ModelProgress) => void): Promise<UnlistenFn> =>
  listen<ModelProgress>('voice:model-progress', (e) => cb(e.payload))

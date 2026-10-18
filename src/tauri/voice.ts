import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { IndicatorEvent } from '@/lib/voice-indicator'
import type { DictationEvent, DictationPhase, ModelRecommendation, ModelStatus } from '@/lib/voice-dictation'
import type { TurnEvent, TurnKindEvent } from '@/lib/voice-turns'

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
  /** Built-in announcements (SWA-66): Swarmterm speaks status itself. */
  speakTurns: boolean
  /** SAPI voice id; empty = the first German voice. */
  ttsVoice: string
  /** 0-100. */
  ttsVolume: number
  /**
   * SWA-58: read Claude's final answer from its transcript and speak its
   * reply after each turn. Off = no transcript is ever opened.
   */
  allowExcerpts: boolean
}

export interface TtsVoice {
  id: string
  name: string
  lang: string
}

export interface TtsStatus {
  ready: boolean
  error: string | null
  voices: TtsVoice[]
  speaking: boolean
}

export interface SpeechStatus {
  models: ModelStatus[]
  dictation: DictationPhase
  recommendation: ModelRecommendation
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
  /** BUZ-5: why an addressed begin found no pane. */
  error?: 'no-target' | 'ambiguous'
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

/** `target` (BUZ-5) is a spoken pane number or name; absent = keyboard focus. */
export const onVoiceFocusRequest = (cb: (requestId: string, target?: string) => void): Promise<UnlistenFn> =>
  listen<{ requestId: string; target?: string }>('voice:focus-request', (e) => cb(e.payload.requestId, e.payload.target))

export const onVoiceInsert = (cb: (e: VoiceInsertEvent) => void): Promise<UnlistenFn> =>
  listen<VoiceInsertEvent>('voice:insert', (e) => cb(e.payload))

/** "Listening" pill on/off for a pinned pane (SWA-40). */
/** SWA-58: a Claude turn failed or was interrupted (ids and kind only). */
export const onVoiceTurnKind = (cb: (e: TurnKindEvent) => void): Promise<UnlistenFn> =>
  listen<TurnKindEvent>('voice:turn-kind', (e) => cb(e.payload))

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

// Built-in announcements (SWA-66). Rust owns the queue and the voice.

/** Silence announcements: all of them, or only one pane's (it was just focused). */
export const voiceTtsStop = (terminalId?: string): Promise<void> =>
  invoke('voice_tts_stop', { terminalId: terminalId ?? null })

/** Speak a sample sentence with the selected voice. Rejects when no voice is available. */
export const voiceTtsTest = (): Promise<void> => invoke('voice_tts_test')

/**
 * Ctrl+Shift+R (SWA-58): Rust reads the excerpt of the last announced pane,
 * else of `focused`, or says that there is none. Rejects with the reason.
 */
export const voiceReadExcerpt = (focused: string | null): Promise<void> =>
  invoke('voice_read_excerpt', { focused })

export const getTtsStatus = (): Promise<TtsStatus> => invoke('voice_tts_status')

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

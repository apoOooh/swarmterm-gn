/**
 * Built-in speech source (SWA-38), renderer side. Rust owns the recording
 * and the pin; it reports each phase as `voice:dictation`, and this module
 * turns those events into the pane-button state and the notification copy.
 * Serde camelCase in lockstep with `src-tauri/src/voice/speech/mod.rs`.
 */

import type { VoiceSettings } from '@/tauri/voice'

export type DictationPhase = 'idle' | 'recording' | 'transcribing'

export interface DictationEvent {
  state: DictationPhase
  terminalId?: string
  reason?: string
}

export interface DictationState {
  phase: DictationPhase
  terminalId: string | null
}

export interface ModelStatus {
  id: string
  label: string
  bytes: number
  ready: boolean
  downloading: boolean
}

/** Which catalog model fits this PC, measured by Rust (speech/recommend.rs). */
export interface ModelRecommendation {
  model: string
  reason: string
  summary: string
  /** Unix milliseconds. */
  measuredAt: number
}

/** Notification key for a dictation that never reached a pane (no-focus …). */
export const DICTATION_ALERT_ID = '__dictation__'

export const IDLE: DictationState = { phase: 'idle', terminalId: null }

export function applyDictation(state: DictationState, e: DictationEvent): DictationState {
  if (e.state === 'idle') return IDLE
  return { phase: e.state, terminalId: e.terminalId ?? state.terminalId }
}

/** Ends the user caused (or a newer dictation did) need no notification. */
const SILENT = new Set(['user', 'superseded'])

const COPY: Record<string, string> = {
  disabled: 'Voice is switched off in Settings → Voice',
  'builtin-off': 'built-in speech recognition is off in Settings → Voice',
  'model-missing': 'the selected speech model is not downloaded — download it in Settings → Voice',
  'mic-unavailable': 'no microphone available, or access was denied in Windows privacy settings',
  busy: 'another dictation is still running',
  'no-focus': 'click into a terminal first',
  'no-speech': 'no speech recognised',
  'too-short': 'recording was too short',
  expired: 'recording hit the 2-minute limit',
  'target-gone': 'pane closed or restarted',
  'target-busy': 'agent is waiting for input',
  composing: 'input method still composing',
  'pin-invalid': 'dictation was cancelled',
  'model-load-failed': 'the speech model could not be loaded — delete and download it again',
  'transcribe-failed': 'speech recognition failed',
  'speech-engine-unavailable': 'this build has no built-in speech engine (built without the local-speech feature)'
}

/** Notification copy for a dictation that did not land, or null. */
export function dictationFailure(reason: string | undefined): string | null {
  if (!reason || SILENT.has(reason)) return null
  return COPY[reason] ?? `dictation failed (${reason})`
}

/** The user switched built-in speech on, whether or not its model is on disk. */
export function builtinSwitchedOn(settings: VoiceSettings | null): boolean {
  return !!settings?.enabled && settings.builtinEnabled
}

/** The pane button is offered only when a dictation can start. */
export function builtinReady(settings: VoiceSettings | null, models: ModelStatus[]): boolean {
  if (!builtinSwitchedOn(settings)) return false
  return models.some((m) => m.id === settings!.model && m.ready)
}

/**
 * Only downloaded models can be picked: choosing one that is not on disk
 * silently switched dictation off. The current choice stays selectable so a
 * stale setting (model deleted, or picked before this rule) is still shown.
 */
export function modelSelectable(model: ModelStatus, selected: string): boolean {
  return model.ready || model.id === selected
}

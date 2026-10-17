import { create } from 'zustand'
import {
  applyDictation,
  builtinReady,
  IDLE,
  type DictationEvent,
  type DictationState,
  type ModelRecommendation,
  type ModelStatus
} from '@/lib/voice-dictation'
import { getSpeechStatus, getVoiceSettings, type ModelProgress, type VoiceSettings } from '@/tauri/voice'

interface VoiceDictationStore {
  dictation: DictationState
  settings: VoiceSettings | null
  models: ModelStatus[]
  recommendation: ModelRecommendation | null
  /** Bytes received per model id while a download runs. */
  progress: Record<string, number>
  /** Pane button + shortcut available (Voice on, built-in on, model on disk). */
  ready: boolean
  refresh: () => Promise<void>
  setSettings: (settings: VoiceSettings) => void
  applyEvent: (e: DictationEvent) => void
  applyProgress: (e: ModelProgress) => void
}

/**
 * Built-in speech source (SWA-38). Fed by `voice:dictation` and
 * `voice:model-progress` (voice-wiring.ts); read by the pane button, the
 * listening pill and Settings → Voice. Rust stays the source of truth —
 * `refresh` re-reads it after anything that may have changed on disk.
 */
export const useVoiceDictationStore = create<VoiceDictationStore>((set, get) => ({
  dictation: IDLE,
  settings: null,
  models: [],
  recommendation: null,
  progress: {},
  ready: false,
  refresh: async () => {
    try {
      const [settings, status] = await Promise.all([getVoiceSettings(), getSpeechStatus()])
      set({ settings, models: status.models, recommendation: status.recommendation, ready: builtinReady(settings, status.models) })
    } catch {
      // Off Windows the speech commands answer `unsupported`: no button.
      set({ ready: false })
    }
  },
  setSettings: (settings) => set({ settings, ready: builtinReady(settings, get().models) }),
  applyEvent: (e) => set((s) => ({ dictation: applyDictation(s.dictation, e) })),
  applyProgress: (e) => {
    if (!e.done) {
      set((s) => ({ progress: { ...s.progress, [e.id]: e.received } }))
      return
    }
    set((s) => {
      const progress = { ...s.progress }
      delete progress[e.id]
      return { progress }
    })
    void get().refresh()
  }
}))

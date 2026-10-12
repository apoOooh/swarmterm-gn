import { create } from 'zustand'
import { applyIndicator, type IndicatorEvent, type IndicatorState } from '@/lib/voice-indicator'

interface VoiceIndicatorStore {
  byTerminal: IndicatorState
  apply: (e: IndicatorEvent) => void
}

/** Fed by `voice:indicator` (voice-wiring.ts); read by VoiceIndicatorPill. */
export const useVoiceIndicatorStore = create<VoiceIndicatorStore>((set) => ({
  byTerminal: {},
  apply: (e) => set((s) => ({ byTerminal: applyIndicator(s.byTerminal, e) }))
}))

import { create } from 'zustand'

/**
 * SWA-88 fallback: a masked prompt that could not be put back into its pane
 * (the user typed there since, or the box would not clear). Session-only and
 * in memory, never persisted, never in the bell: the pane's pill offers it
 * for copying until dismissed, the pane dies or the next one replaces it.
 */
export interface PromptResubmitStore {
  byTerminal: Record<string, string>
  offer: (terminalId: string, text: string) => void
  dismiss: (terminalId: string) => void
}

export const usePromptResubmitStore = create<PromptResubmitStore>((set) => ({
  byTerminal: {},
  offer: (terminalId, text) => set((s) => ({ byTerminal: { ...s.byTerminal, [terminalId]: text } })),
  dismiss: (terminalId) =>
    set((s) => {
      if (!(terminalId in s.byTerminal)) return s
      const byTerminal = { ...s.byTerminal }
      delete byTerminal[terminalId]
      return { byTerminal }
    })
}))

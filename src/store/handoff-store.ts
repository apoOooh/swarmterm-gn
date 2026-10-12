import { create } from 'zustand'
import { initialHandoff, reduceHandoff, type HandoffEvent, type HandoffState, type HandoffTarget } from '@/lib/handoff-flow'

/** What the handoff was started from: the SWA-21 brief and its source pane. */
export interface HandoffSource {
  leafId: string
  terminalId: string
  cwd: string
  brief: string
}

/**
 * The one handoff in flight (SWA-22). Lives outside the pane tree because the
 * split that creates the target pane re-parents the source pane, and its React
 * state would not survive that. UI state only; transitions are
 * lib/handoff-flow's reducer.
 */
export interface HandoffStore {
  source?: HandoffSource
  target?: HandoffTarget
  state: HandoffState
  /** Dialog tucked away into a non-modal chip so the user can answer a
   *  trust/login prompt in the new pane; the handoff itself keeps running. */
  minimized: boolean
  begin: (source: HandoffSource) => void
  setTarget: (target: HandoffTarget) => void
  dispatch: (event: HandoffEvent) => void
  close: () => void
  minimize: () => void
  restore: () => void
}

export const useHandoffStore = create<HandoffStore>((set) => ({
  state: initialHandoff(),
  minimized: false,
  begin: (source) => set({ source, target: undefined, state: initialHandoff(), minimized: false }),
  setTarget: (target) => set({ target }),
  dispatch: (event) =>
    set((s) => {
      const next = reduceHandoff(s.state, event)
      return next === s.state ? s : { state: next }
    }),
  close: () => set({ source: undefined, target: undefined, state: initialHandoff(), minimized: false }),
  minimize: () => set((s) => (s.source ? { minimized: true } : s)),
  restore: () => set({ minimized: false })
}))

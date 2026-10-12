/**
 * "Listening" pill state (SWA-40): which pin each pane currently shows.
 * Keyed by pin, not just pane, because a second dictation on the same pane
 * supersedes the first and Rust's on(new)/off(old) may arrive in either
 * order — an off for a pin the pane no longer shows must not hide the new one.
 */

export interface IndicatorEvent {
  terminalId: string
  pin: string
  active: boolean
}

/** terminalId → pin of the dictation the pane shows. */
export type IndicatorState = Readonly<Record<string, string>>

export function applyIndicator(state: IndicatorState, e: IndicatorEvent): IndicatorState {
  if (e.active) {
    return state[e.terminalId] === e.pin ? state : { ...state, [e.terminalId]: e.pin }
  }
  if (state[e.terminalId] !== e.pin) return state
  const next = { ...state }
  delete next[e.terminalId]
  return next
}

import { sanitizePromptText } from '@/lib/prompt-sanitize'
import type { AgentEngineState } from '@/lib/agent-state/types'

/**
 * Rules for dictated text (SWA-12). Dictation is the USER's own input, typed
 * by voice instead of keys, so it differs from a War Room delivery in two
 * ways: it does not wait for the typing hold, and afterwards the pane counts
 * as "typed in" so a room delivery cannot paste over the draft.
 *
 * What it shares with War Room bodies: sanitising before framing (a body
 * carrying `\x1b[201~` would end the paste early and run the rest as
 * keystrokes), and the Enter as its own later write (agent TUIs swallow an
 * Enter in the same stdin flush as a bracketed paste).
 */

export type DictationRejection = 'target-busy'

/**
 * Bytes for the body write. Without bracketed paste (a plain shell) a line
 * break IS Enter and a tab IS completion, so both become spaces: dictation
 * must never run or complete anything on its own.
 */
export function prepareDictationBody(text: string, bracketed: boolean): string {
  const clean = sanitizePromptText(text)
  if (bracketed) return `\x1b[200~${clean.replace(/\r?\n/g, '\r')}\x1b[201~`
  return clean.replace(/\r\n|[\r\n\t]/g, ' ')
}

/**
 * A pane blocked on a permission prompt gets nothing: dictated text could
 * answer the prompt. The state is detected asynchronously from output, so
 * this narrows the window rather than closing it — which is why submit is
 * off by default.
 */
export function insertRejection(state: AgentEngineState | undefined): DictationRejection | null {
  return state === 'blocked' ? 'target-busy' : null
}

export interface SubmitCheck {
  requested: boolean
  allowAutoEnter: boolean
  bracketed: boolean
  agentState: AgentEngineState | undefined
  sameGeneration: boolean
  /** Typing-store `lastKeyAt` stamped by the draft insert itself. */
  inputStampAtInsert: number
  /** The same stamp right before the Enter; any user key moves or clears it. */
  inputStampNow: number | undefined
}

/**
 * Re-checked right before the delayed Enter. Any doubt keeps the draft
 * visible and unsent — and there is no later retry, the user decides.
 */
export function shouldSubmitDictation(c: SubmitCheck): boolean {
  return (
    c.requested &&
    c.allowAutoEnter &&
    c.bracketed &&
    c.sameGeneration &&
    c.agentState !== 'working' &&
    c.agentState !== 'blocked' &&
    c.inputStampNow === c.inputStampAtInsert
  )
}

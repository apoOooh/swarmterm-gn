/**
 * "Does the agent's input box hold unsent text?" — read from the screen, not
 * from the typing store. The typing store only knows keystrokes this renderer
 * saw; a draft that survived a terminal-host reattach (or was typed before a
 * Swarmterm restart) is invisible to it, and typing a War Room nudge into
 * such a pane appends to the draft and the Enter sends the user's text.
 *
 * Pure: the caller hands in the bottom screen lines with DIM cells already
 * blanked (Claude Code renders its empty-box placeholder suggestion dim, so
 * without that an empty box would read as a draft). Only Claude Code's box
 * is recognised — two horizontal rules with a `>`/`❯` prompt line between —
 * any other layout answers false and the typing store stays the only guard.
 */
import { isHorizontalRule, promptBoxBody } from '@/lib/agent-state/regions'

const PROMPT_MARKERS = new Set(['>', '❯'])

export function promptBoxHasDraft(screen: string): boolean {
  const body = promptBoxBody(screen)
  if (body === '') return false
  const lines = body.split('\n').map((l) => l.replace(/^\s*│/, '').replace(/│\s*$/, '').trim())
  const first = lines.findIndex((l) => l !== '')
  if (first === -1) return false
  const marker = lines[first][0]
  // No prompt marker: not the input box we know (a menu or dialog between
  // two rules) — no opinion.
  if (!PROMPT_MARKERS.has(marker)) return false
  lines[first] = lines[first].slice(1).trim()
  return lines.some((l) => l !== '')
}

/** One screen row as the registry reads it: DIM cells already blanked in
 *  `text`, and whether the row had any DIM cell at all. */
export interface DraftRow {
  text: string
  dim: boolean
}

/**
 * SWA-88: the exact text of the draft in Claude Code's box, or `undefined`
 * whenever it cannot be read back without guessing. Only the unambiguous
 * case answers: ONE non-empty body row (`>`/`❯` marker, one space, text),
 * no DIM cell anywhere in the box (a blanked cell may have been part of the
 * text), and the row ending well before the right edge — a row that reaches
 * it may be cut off, and a draft over several rows cannot tell an Ink wrap
 * from a typed newline. The caller compares the result with the blocked
 * prompt's fingerprint and falls back on `undefined` or a mismatch, so
 * every doubt here costs only the automatic resubmit, never the user's text.
 */
export function promptBoxDraftText(rows: readonly DraftRow[], cols: number): string | undefined {
  const rules: number[] = []
  for (let i = rows.length - 1; i >= 0 && rules.length < 2; i--) {
    if (isHorizontalRule(rows[i].text)) rules.push(i)
  }
  if (rules.length < 2) return undefined
  const [bottom, top] = rules
  const body = rows.slice(top + 1, bottom)
  if (body.some((r) => r.dim)) return undefined
  const filled = body.filter((r) => r.text.trim() !== '')
  if (filled.length !== 1) return undefined
  let row = filled[0].text.trimEnd()
  // Older layouts draw side borders: `│ > text │`.
  if (row.trimStart().startsWith('│')) {
    row = row.trimStart().slice(1)
    if (row.endsWith('│')) row = row.slice(0, -1)
    row = row.trimEnd()
  }
  // Room left on the row: the draft provably ended here.
  if (row.length >= cols - EDGE_MARGIN) return undefined
  const start = row.trimStart()
  if (!PROMPT_MARKERS.has(start[0]) || start[1] !== ' ') return undefined
  const text = start.slice(2)
  return text.trim() === '' ? undefined : text
}

/** Columns kept free at the right edge for `promptBoxDraftText`. */
const EDGE_MARGIN = 4

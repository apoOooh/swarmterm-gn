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
import { promptBoxBody } from '@/lib/agent-state/regions'

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

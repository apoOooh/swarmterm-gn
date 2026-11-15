/**
 * SWA-96: is a Claude Code choice dialog (AskUserQuestion) showing with its
 * free-text row selected and still empty? The agent detector files every
 * such dialog under `blocked`, like a permission prompt, so dictation would
 * be refused (`insertRejection`) although the user is about to type an
 * answer into "Type something".
 *
 * Pure and strict on purpose: only the empty field is recognised (its label
 * is the placeholder), never a row that already holds text — a filled row
 * cannot be told apart from an ordinary option without guessing. Any doubt
 * answers false and the old refusal stands; a permission prompt
 * ("Do you want to proceed?") always answers false, since dictated text
 * there could answer it.
 *
 * The caller hands in the visible screen rows (bottom of the buffer).
 */
const SELECTED_OPTION = /^\s*[❯>]\s*\d+\.\s*(.*)$/
const FREE_TEXT_LABEL = /^type something\b/i

/** Permission and approval phrasing from the Claude manifest's blockers;
 *  any of them on screen vetoes, even if a question merely uses the words. */
const PERMISSION_MARKERS = [
  'do you want to',
  'would you like to',
  'waiting for permission',
  'allow this connection',
  'tab to amend',
  'ctrl+e to explain'
]

export function choiceFreeTextActive(rows: readonly string[]): boolean {
  const lower = rows.map((r) => r.toLowerCase())
  if (!lower.some((r) => r.includes('enter to select'))) return false
  if (lower.some((r) => PERMISSION_MARKERS.some((m) => r.includes(m)))) return false
  const selected = rows.map((r) => SELECTED_OPTION.exec(r)).filter((m) => m !== null)
  // Exactly one highlighted option, or the layout is not the one we know.
  if (selected.length !== 1) return false
  return FREE_TEXT_LABEL.test(selected[0][1].trim())
}

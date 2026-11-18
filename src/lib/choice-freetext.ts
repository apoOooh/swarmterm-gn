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
// The highlight marker sits in column 0; an indented continuation row of a
// wrapped answer that happens to read "> 2." must not count (SWA-107).
const SELECTED_OPTION = /^[❯>]\s*(\d+)\.\s*(.*)$/
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

/**
 * SWA-107: shape of the open AskUserQuestion dialog as Claude Code's
 * PermissionRequest hook reported it (`hook/mod.rs::ChoiceQuestion`).
 */
export interface ChoiceQuestion {
  options: number
  multiSelect: boolean
}

/**
 * With `choice` (hook-confirmed dialog) the free-text row is recognised by
 * its NUMBER — `options + 1` — never by its content, so a filled field, a
 * long answer wrapped over several rows or a second dictation all still
 * count (SWA-107). The number must be unambiguous: if any question lists it
 * as an ordinary option (several questions with different option counts),
 * or any question is multi-select (other layout, not verified), the answer
 * is false. Without `choice` (older Claude Code, hook missing) the SWA-96
 * rule stands: only the empty "Type something" row.
 */
export function choiceFreeTextActive(rows: readonly string[], choice?: readonly ChoiceQuestion[]): boolean {
  const lower = rows.map((r) => r.toLowerCase())
  if (!lower.some((r) => r.includes('enter to select'))) return false
  const hits = rows.map((r, i) => ({ i, m: SELECTED_OPTION.exec(r) })).filter((h) => h.m !== null)
  // Exactly one highlighted option, or the layout is not the one we know.
  if (hits.length !== 1) return false
  const { i: at, m } = hits[0] as { i: number; m: RegExpExecArray }
  // The selected row and its wrapped continuation (down to the separator)
  // hold the user's own answer: phrasing there must not veto (SWA-107).
  let end = at + 1
  while (end < rows.length && !rows[end].trimStart().startsWith('─')) end++
  const outside = lower.filter((_, i) => i < at || i >= end)
  if (outside.some((r) => PERMISSION_MARKERS.some((mk) => r.includes(mk)))) return false
  if (choice && choice.length > 0) {
    if (choice.some((q) => q.multiSelect)) return false
    // Which question's tab is showing is not known; only when every
    // question has the same option count is "options + 1" the free-text row
    // on every tab (else it can be another tab's "Chat about this").
    const options = choice[0].options
    if (choice.some((q) => q.options !== options)) return false
    return Number(m[1]) === options + 1
  }
  return FREE_TEXT_LABEL.test(m[2].trim())
}

/**
 * SWA-107: whether the selected row already holds text, so a further
 * dictation gets a separating space instead of being glued to the last word.
 * Only decides that space — never whether text may be written (that is
 * `choiceFreeTextActive`). Reads the selected row's first screen line; its
 * own trailing space is not visible (xterm trims), so at worst two spaces.
 */
export function choiceFreeTextFilled(rows: readonly string[]): boolean {
  const selected = rows.map((r) => SELECTED_OPTION.exec(r)).filter((m) => m !== null)
  if (selected.length !== 1) return false
  const content = selected[0][2].trim()
  return content.length > 0 && !FREE_TEXT_LABEL.test(content)
}

import type { AgentHookSignal } from '@/tauri/agent-state'
import type { ChoiceQuestion } from '@/lib/choice-freetext'

/**
 * SWA-107: the pane's AskUserQuestion dialog shape after one hook edge.
 *
 * - A PermissionRequest for AskUserQuestion carries the shape: set it.
 * - Any other PermissionRequest (or an unknown shape) carries an EMPTY
 *   list: end it, so a real permission prompt never meets a stale dialog.
 * - SessionStart/End (`forget`): end it.
 * - Every other edge (PostToolUse of a background task, an idle_prompt
 *   Notification while the user thinks) says nothing about the dialog and
 *   keeps it. The end of the dialog itself is seen by the detector: the
 *   registry drops the shape as soon as the pane is published as anything
 *   but `blocked` (answer, Esc — which fires no Stop —, interrupt), and on
 *   respawn/retry.
 */
export function nextChoice(
  current: ChoiceQuestion[] | undefined,
  signal: AgentHookSignal,
  choice: ChoiceQuestion[] | undefined
): ChoiceQuestion[] | undefined {
  if (signal === 'forget') return undefined
  if (choice === undefined) return current
  return choice.length > 0 ? choice : undefined
}

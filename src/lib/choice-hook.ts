import type { AgentHookSignal } from '@/tauri/agent-state'
import type { ChoiceQuestion } from '@/lib/choice-freetext'

/**
 * SWA-107: the pane's AskUserQuestion dialog shape after one hook edge.
 * The PermissionRequest that opens the dialog carries it; any non-blocked
 * edge ends it (PostToolUse = answered, Stop = turn over incl. Esc,
 * UserPromptSubmit, SessionStart/End). A blocked edge WITHOUT a shape
 * (a Notification for the same dialog) keeps it: the screen check still
 * vetoes a real permission prompt (`choiceFreeTextActive`).
 */
export function nextChoice(
  current: ChoiceQuestion[] | undefined,
  signal: AgentHookSignal,
  choice: ChoiceQuestion[] | undefined
): ChoiceQuestion[] | undefined {
  if (signal !== 'blocked') return undefined
  return choice && choice.length > 0 ? choice : current
}

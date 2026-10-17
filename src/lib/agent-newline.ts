import { isPlainShellPane } from '@/lib/templates'

/**
 * Shift+Enter inside an agent pane inserts a line break instead of submitting.
 *
 * xterm.js maps Shift+Enter to the same `\r` as Enter (it has no kitty or
 * win32-input keyboard protocol), and ConPTY then hands the agent a plain
 * Enter, so Claude Code submitted every line of a multi-line prompt. Whether
 * that showed depended on timing: input typed while the CLI was still busy
 * arrived as one burst and was taken as a paste. LF (Ctrl+J) is the one
 * newline key Claude Code, Codex and OpenCode all accept, so it is what VS
 * Code's `/terminal-setup` style bindings boil down to here. Plain shells keep
 * `\r`: PSReadLine/cmd have no multi-line draft to extend.
 */
export const AGENT_NEWLINE = '\n'

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'> & { isComposing?: boolean }

export function isShiftEnter(event: KeyLike): boolean {
  return event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing
}

/** The bytes to send for this key in a pane running `agentId`, or null to leave it to xterm. */
export function agentNewlineFor(event: KeyLike, agentId: string | undefined): string | null {
  if (!isShiftEnter(event) || agentId === undefined || isPlainShellPane(agentId)) return null
  return AGENT_NEWLINE
}

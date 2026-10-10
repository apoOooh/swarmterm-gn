/**
 * Focus reports (`ESC [ I` / `ESC [ O`): ConPTY switches DECSET 1004 on by
 * itself, so xterm sends one through onData on every focus change of a pane.
 *
 * While an agent CLI starts up (Claude Code: node boots, then switches the
 * console to raw input) a report that arrives before raw mode is echoed by
 * the cooked console verbatim, as a visible `^[[I` above the banner. Our own
 * focus-return after a click, the window re-focus and the first attach all
 * land in exactly that gap. The program's own `?1004h` never reaches us
 * reliably (ConPTY already has the mode on), so the only usable anchor is the
 * pty start: agent panes drop reports for a short window after it. A lost
 * focus-in that early is harmless — nothing focus-dependent is drawn yet.
 * Plain shells are exempt: their line editors consume the reports.
 */

/** How long after the pty starts an agent pane drops focus reports. */
export const AGENT_START_FOCUS_GRACE_MS = 5000

export function isFocusReport(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O'
}

/** Should this focus report be swallowed instead of reaching the pty? */
export function shouldDropFocusReport(
  isAgentPane: boolean,
  startedAt: number | undefined,
  now: number
): boolean {
  return isAgentPane && startedAt !== undefined && now - startedAt < AGENT_START_FOCUS_GRACE_MS
}

import type { IWindowsPty } from '@xterm/xterm'

/**
 * xterm.js option telling it the pty is ConPTY. Without it xterm treats wrap
 * and resize like a Unix pty, while ConPTY repaints the viewport itself — a
 * TUI whose input box shrinks (Claude Code after a multi-line submit) then
 * leaves orphaned blank lines at the bottom. VS Code sets the same option.
 */
export function windowsPtyOption(isWindows: boolean, buildNumber: number | null): IWindowsPty | undefined {
  if (!isWindows) return undefined
  return buildNumber ? { backend: 'conpty', buildNumber } : { backend: 'conpty' }
}

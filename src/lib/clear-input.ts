import type { ShellFlavor } from '@/lib/agent-spawn-command'

/**
 * Bytes that empty the pending input line of a pane — for when a prompt was
 * refused (e.g. by a submit hook) and the text is still sitting there.
 *
 * Agent TUIs (Claude Code, Codex, …) clear a non-empty prompt on one Ctrl+C;
 * only a SECOND Ctrl+C in quick succession quits them, which `ClearGuard`
 * prevents. Shells get their own line-kill instead: PSReadLine and cmd revert
 * the line on Esc, readline kills it with Ctrl+E (end) + Ctrl+U (to start).
 */
export function clearInputSequence(agentId: string | undefined, flavor: ShellFlavor): string {
  if (agentId && agentId !== 'terminal') return '\x03'
  if (flavor === 'posix') return '\x05\x15'
  return '\x1b'
}

/** Minimum gap between two clears of one pane, so Ctrl+C can never double up into "quit". */
export const CLEAR_COOLDOWN_MS = 2000

export class ClearGuard {
  private last = new Map<string, number>()
  /** True when a clear may be sent now; records it. */
  allow(terminalId: string, now: number = Date.now()): boolean {
    const prev = this.last.get(terminalId)
    if (prev !== undefined && now - prev < CLEAR_COOLDOWN_MS) return false
    this.last.set(terminalId, now)
    return true
  }
}

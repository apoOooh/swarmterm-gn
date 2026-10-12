import type { ThreadMessage } from '@/tauri/sessions'

/** Agents whose session files the thread view can read (SWA-25). */
export const THREAD_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'codex'])

export function canShowThread(agentId: string, sessionId: string | undefined): boolean {
  return THREAD_AGENTS.has(agentId) && !!sessionId
}

export type ThreadItem =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; at?: string }
  | { kind: 'tools'; steps: string[] }

/**
 * Messages → display items. Consecutive tool steps collapse into one row so a
 * long tool loop does not bury the conversation; hidden entirely when
 * `showTools` is off.
 */
export function threadItems(messages: readonly ThreadMessage[], showTools: boolean): ThreadItem[] {
  const out: ThreadItem[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!showTools) continue
      const last = out[out.length - 1]
      if (last?.kind === 'tools') last.steps.push(m.text)
      else out.push({ kind: 'tools', steps: [m.text] })
      continue
    }
    out.push({ kind: 'message', role: m.role, text: m.text, at: m.at })
  }
  return out
}

/** `HH:MM` local time of an ISO stamp; empty for missing/invalid. */
export function threadTime(at: string | undefined): string {
  if (!at) return ''
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

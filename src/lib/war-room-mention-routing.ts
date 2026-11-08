/**
 * Who a composer message goes to, decided from its @-mentions (user decision
 * 2026-10-24):
 *
 * - No mention: exactly today's path — one send to the picker's target
 *   (`to: null` for Everyone). Nothing here may change that call.
 * - `@everyone` anywhere: one broadcast (`to: null`), the same call as the
 *   no-mention Everyone send, whatever else is mentioned.
 * - Otherwise: one send per distinct mentioned War Room member, full text as
 *   written (the @tokens stay so each recipient sees who else was addressed).
 * - Any mention that does not resolve to a member — unknown, ambiguous, or a
 *   pane outside the War Room — blocks the whole send. Never a partial send,
 *   never a fallback to broadcasting.
 *
 * Mentions inside inline code or fenced blocks are not mentions; otherwise
 * the rule is the popup's: `@` at the start or after whitespace/`(`.
 *
 * Built on the existing `war_room_moderator_send` API (one recipient or null
 * per call), so the Rust delivery path is untouched.
 */
import type { WarRoomMode } from '@/tauri/warroom'
import { EVERYONE, composerTargets, validateComposer, type ComposerMember } from '@/lib/war-room-composer'
import { tokenizeMarkdown } from '@/lib/war-room-markdown'
import {
  EVERYONE_MENTION,
  buildCandidates,
  resolveMention,
  tokenizeMentions,
  type CandidatePane
} from '@/lib/war-room-mentions'

/** Mention names in routable prose (code spans/blocks excluded), in order. */
export function routableMentions(text: string): string[] {
  // Blank code out IN PLACE (same length, spaces) and tokenize the original
  // string once, so the `@` boundary rule sees the real preceding character —
  // tokenizing each markdown piece from index 0 would invent boundaries.
  let blanked = ''
  for (const tok of tokenizeMarkdown(text)) {
    if (tok.t === 'code') blanked += ' '.repeat(tok.v.length + 2)
    else if (tok.t === 'bold') blanked += `**${tok.v}**`
    else if (tok.t === 'text') blanked += tok.v
    else blanked += ' '
  }
  // Codeblocks lose their exact length (fence + language tag), but nothing
  // after them depends on offsets — only on neighbouring characters.
  return tokenizeMentions(blanked)
    .filter((s) => s.t === 'mention')
    .map((s) => (s as { name: string }).name)
}

export interface SendCall {
  to: string | null
}

export type SendPlan =
  | {
      ok: true
      calls: SendCall[]
      /** What the recipient line shows. */
      recipients:
        | { kind: 'picker' }
        | { kind: 'everyone'; peers: number }
        | { kind: 'mentioned'; ids: string[] }
    }
  | { ok: false; reason: string }

export function planSend(input: {
  text: string
  targetId: string
  mode: WarRoomMode
  members: ComposerMember[]
  /** Open panes (read lazily, only when a member mention needs resolving), to tell "not in the War Room" from "not found". */
  panes: () => CandidatePane[]
}): SendPlan {
  const { text, targetId, mode, members } = input
  const names = routableMentions(text)

  if (names.length === 0) {
    const v = validateComposer({ text, targetId, mode, members })
    if (!v.ok) return v
    return { ok: true, calls: [{ to: targetId === EVERYONE ? null : targetId }], recipients: { kind: 'picker' } }
  }
  if (text.trim() === '') return { ok: false, reason: 'Message is empty.' }

  const everyone = names.some((n) => n.toLowerCase() === EVERYONE_MENTION)
  if (everyone) {
    if (mode === 'execute') {
      return { ok: false, reason: '@everyone cannot execute — a prompt runs in exactly one terminal per mention.' }
    }
    const peers = members.filter((m) => m.connected).length
    if (peers === 0) return { ok: false, reason: '@everyone: no connected agents in the War Room yet.' }
    return { ok: true, calls: [{ to: null }], recipients: { kind: 'everyone', peers } }
  }

  // Resolve against members AND panes together: resolving among members first
  // would let `@api` reach member "api2" by prefix while the user meant the
  // (non-member) pane "api" — routing on a guess.
  const all = buildCandidates(members, input.panes())
  const memberIds = new Set(members.map((x) => x.terminalId))
  const rows = composerTargets(members, mode)
  const ids: string[] = []
  const problems: string[] = []
  for (const name of names) {
    const r = resolveMention(name, all)
    if (r.status === 'ambiguous') {
      problems.push(`@${name} matches several panes`)
      continue
    }
    if (r.status === 'unresolved') {
      problems.push(`@${name} not found`)
      continue
    }
    if (!memberIds.has(r.id)) {
      problems.push(`@${name} is not in the War Room`)
      continue
    }
    const row = rows.find((t) => t.id === r.id)
    if (row !== undefined && row.disabled !== null) {
      problems.push(`@${name}: ${row.disabled}`)
      continue
    }
    if (!ids.includes(r.id)) ids.push(r.id)
  }
  if (problems.length > 0) return { ok: false, reason: `Not sent — ${problems.join('; ')}.` }
  // Execute pastes and runs a prompt; doing that in several terminals at once
  // is irreversible and outside the mode's one-terminal contract.
  if (mode === 'execute' && ids.length > 1) {
    return { ok: false, reason: 'Execute runs in one terminal — mention a single agent.' }
  }
  return { ok: true, calls: ids.map((to) => ({ to })), recipients: { kind: 'mentioned', ids } }
}

/**
 * Run a plan through the send function, one call per recipient, in order.
 * Stops at the first failure and rethrows it with how many already went out,
 * so the user knows a retry would repeat those.
 */
export async function runSendPlan(
  calls: SendCall[],
  base: { roomId: string; content: string; mode: WarRoomMode },
  send: (args: { roomId: string; to: string | null; content: string; mode: WarRoomMode }) => Promise<unknown>
): Promise<void> {
  for (let i = 0; i < calls.length; i++) {
    try {
      await send({ roomId: base.roomId, to: calls[i].to, content: base.content, mode: base.mode })
    } catch (e) {
      if (i === 0) throw e
      throw new Error(`${String(e)} (already delivered to ${i} of ${calls.length})`)
    }
  }
}

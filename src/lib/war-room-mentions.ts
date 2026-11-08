/**
 * @-mentions for the War Room composer and transcript: who can be mentioned,
 * how a typed query ranks them, how a mention is written into the text, and
 * how a sent message is split back into text and mention spans.
 *
 * Token format: `@name` when the name is only letters, digits and `_ . -`;
 * anything else is quoted, `@"My pane"`, with `\"` and `\\` escaped. Quoting
 * instead of replacing spaces keeps the token round-trippable to the exact
 * name, so resolving never has to guess which pane `@My_pane` meant.
 *
 * Pure and framework-free so the composer, the transcript and the tests share
 * one definition; the component only wires the caret and the store to it.
 */

import { collectLeaves, type LayoutNode } from '@/lib/layout-tree'

export type MentionKind = 'everyone' | 'peer' | 'agent' | 'shell'

/**
 * Reserved: `@everyone` always means the whole room. A pane or member that is
 * literally named "everyone" is left out of the candidates rather than shown
 * under a second label — it could never be addressed unambiguously anyway.
 */
export const EVERYONE_MENTION = 'everyone'
export const EVERYONE_CANDIDATE: MentionCandidate = {
  id: '__mention_everyone__',
  name: EVERYONE_MENTION,
  kind: 'everyone',
  agentId: null,
  hint: 'all in the War Room'
}

export interface MentionCandidate {
  /** terminalId — what a mention resolves to. */
  id: string
  name: string
  kind: MentionKind
  /** Agent catalog id (claude, codex, …) when the pane runs one. */
  agentId: string | null
  /** Shown next to duplicate names so two "api" panes can be told apart. */
  hint?: string
}

export interface CandidateMember {
  terminalId: string
  name: string
  agentId: string | null
}

export interface CandidatePane {
  terminalId: string
  /** User-given pane name; unnamed panes are not mentionable. */
  name?: string
  agentId?: string
  workspaceName: string
}

/** Every open pane across all workspaces, flattened for `buildCandidates`. */
export function namedPanes(workspaces: Array<{ name: string; layout: LayoutNode }>): CandidatePane[] {
  return workspaces.flatMap((w) =>
    collectLeaves(w.layout).map((l) => ({
      terminalId: l.terminalId,
      name: l.name,
      agentId: l.agentId,
      workspaceName: w.name
    }))
  )
}

/**
 * War Room members of the room first (they are who the composer talks to),
 * then other open panes the user gave a name. Unnamed panes are skipped: an
 * automatic title like "Claude Code · repo" repeats across panes and would
 * resolve to nobody. A member keeps its peer row even when its pane is named.
 */
export function buildCandidates(members: CandidateMember[], panes: CandidatePane[]): MentionCandidate[] {
  const seen = new Set<string>()
  const out: MentionCandidate[] = []
  const reserved = (n: string): boolean => n.trim().toLowerCase() === EVERYONE_MENTION
  for (const m of members) {
    if (m.name.trim() === '' || reserved(m.name) || seen.has(m.terminalId)) continue
    seen.add(m.terminalId)
    out.push({ id: m.terminalId, name: m.name, kind: 'peer', agentId: m.agentId })
  }
  for (const p of panes) {
    const name = p.name?.trim()
    if (!name || reserved(name) || seen.has(p.terminalId)) continue
    seen.add(p.terminalId)
    const agentId = p.agentId && p.agentId !== 'terminal' ? p.agentId : null
    out.push({ id: p.terminalId, name, kind: agentId ? 'agent' : 'shell', agentId, hint: p.workspaceName })
  }
  // Hints only where they disambiguate; elsewhere they are noise.
  const counts = new Map<string, number>()
  for (const c of out) counts.set(c.name.toLowerCase(), (counts.get(c.name.toLowerCase()) ?? 0) + 1)
  return out.map((c) => {
    if ((counts.get(c.name.toLowerCase()) ?? 0) > 1) return { ...c, hint: c.hint ?? 'War Room' }
    const { hint: _hint, ...rest } = c
    return rest
  })
}

// ---------------------------------------------------------------------------
// Matching

export interface MentionMatch {
  candidate: MentionCandidate
  /** 0 prefix · 1 word start · 2 substring · 3 fuzzy subsequence. */
  tier: number
  /** Half-open [start, end) ranges of `name` to highlight. */
  ranges: Array<[number, number]>
}

export const MAX_SUGGESTIONS = 8

const WORD_BREAK = /[\s_.\-/:]/

function wordStarts(name: string): number[] {
  const starts: number[] = []
  for (let i = 1; i < name.length; i++) {
    const prev = name[i - 1]
    const ch = name[i]
    if (WORD_BREAK.test(prev) || (prev === prev.toLowerCase() && ch !== ch.toLowerCase())) starts.push(i)
  }
  return starts
}

function matchOne(c: MentionCandidate, q: string): MentionMatch | null {
  const name = c.name
  if (q === '') return { candidate: c, tier: 0, ranges: [] }
  const lower = name.toLowerCase()
  if (lower.startsWith(q)) return { candidate: c, tier: 0, ranges: [[0, q.length]] }
  for (const s of wordStarts(name)) {
    if (lower.startsWith(q, s)) return { candidate: c, tier: 1, ranges: [[s, s + q.length]] }
  }
  const at = lower.indexOf(q)
  if (at >= 0) return { candidate: c, tier: 2, ranges: [[at, at + q.length]] }
  const ranges: Array<[number, number]> = []
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] !== q[j]) continue
    const last = ranges[ranges.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else ranges.push([i, i + 1])
    j++
  }
  return j === q.length ? { candidate: c, tier: 3, ranges } : null
}

/**
 * Rank candidates for `query` (case-insensitive). Ties keep the candidate
 * order (peers first), so the list does not reshuffle as the user types.
 */
export function matchCandidates(
  candidates: MentionCandidate[],
  query: string,
  limit = MAX_SUGGESTIONS
): MentionMatch[] {
  const q = query.toLowerCase()
  const hits: Array<MentionMatch & { order: number }> = []
  candidates.forEach((c, order) => {
    const m = matchOne(c, q)
    if (m) hits.push({ ...m, order })
  })
  hits.sort((a, b) => a.tier - b.tier || a.order - b.order)
  return hits.slice(0, limit).map(({ order: _o, ...m }) => m)
}

// ---------------------------------------------------------------------------
// Token format

const BARE_NAME = /^[\p{L}\p{N}_.\-]+$/u

export function formatMention(name: string): string {
  if (BARE_NAME.test(name)) return `@${name}`
  return `@"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Trailing sentence punctuation belongs to the sentence: "ask @api." */
const TRAILING_PUNCT = /[.,:;!?)]+$/

export type MentionSegment =
  | { t: 'text'; v: string }
  | { t: 'mention'; name: string; raw: string }

/**
 * Split text into plain runs and mention spans. A mention starts with `@` at
 * the beginning or after whitespace/`(` (so `a@b.c` stays an e-mail), followed
 * by a bare name or a closed quoted name. An unclosed quote is plain text.
 */
export function tokenizeMentions(text: string): MentionSegment[] {
  const out: MentionSegment[] = []
  let buf = ''
  let i = 0
  const flush = (): void => {
    if (buf) out.push({ t: 'text', v: buf })
    buf = ''
  }
  while (i < text.length) {
    const ch = text[i]
    const boundary = i === 0 || /[\s(*]/.test(text[i - 1])
    if (ch === '@' && boundary) {
      const quoted = readQuoted(text, i + 1)
      if (quoted) {
        flush()
        out.push({ t: 'mention', name: quoted.name, raw: text.slice(i, quoted.end) })
        i = quoted.end
        continue
      }
      let end = i + 1
      while (end < text.length && /[\p{L}\p{N}_.\-]/u.test(text[end])) end++
      let name = text.slice(i + 1, end)
      const trail = TRAILING_PUNCT.exec(name)
      if (trail) {
        name = name.slice(0, trail.index)
        end -= trail[0].length
      }
      if (name) {
        flush()
        out.push({ t: 'mention', name, raw: text.slice(i, end) })
        i = end
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

function readQuoted(text: string, from: number): { name: string; end: number } | null {
  if (text[from] !== '"') return null
  let name = ''
  for (let i = from + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      name += text[++i]
      continue
    }
    if (ch === '"') return name ? { name, end: i + 1 } : null
    if (ch === '\n') return null
    name += ch
  }
  return null
}

// ---------------------------------------------------------------------------
// Resolution

export type MentionResolution =
  | { status: 'resolved'; id: string }
  | { status: 'ambiguous'; ids: string[] }
  | { status: 'unresolved' }

/**
 * Exact name (case-insensitive) wins; otherwise a prefix that matches exactly
 * one candidate. Two candidates with the same name are `ambiguous` — the
 * transcript shows both and nothing is ever routed on a guess.
 */
export function resolveMention(name: string, candidates: MentionCandidate[]): MentionResolution {
  const key = name.toLowerCase()
  // The reserved token wins before any candidate can match it.
  if (key === EVERYONE_MENTION) return { status: 'resolved', id: EVERYONE_CANDIDATE.id }
  const exact = candidates.filter((c) => c.name.toLowerCase() === key)
  if (exact.length === 1) return { status: 'resolved', id: exact[0].id }
  if (exact.length > 1) return { status: 'ambiguous', ids: exact.map((c) => c.id) }
  const prefix = candidates.filter((c) => c.name.toLowerCase().startsWith(key))
  if (prefix.length === 1) return { status: 'resolved', id: prefix[0].id }
  return { status: 'unresolved' }
}

/** Distinct ids of every resolved mention, in first-mention order. */
export function mentionedIds(text: string, candidates: MentionCandidate[]): string[] {
  const ids: string[] = []
  for (const seg of tokenizeMentions(text)) {
    if (seg.t !== 'mention') continue
    const r = resolveMention(seg.name, candidates)
    if (r.status === 'resolved' && !ids.includes(r.id)) ids.push(r.id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Composer caret handling

export interface ActiveMention {
  /** Index of the `@`. */
  start: number
  query: string
  /** True while typing inside `@"…`. */
  quoted: boolean
}

/**
 * The mention being typed at `caret`, if any (caret-based, so mid-text works).
 * A quoted query ends at its first `"`: typing an escaped `\"` mid-query is
 * not supported (pick the name from the list instead — accept escapes it).
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  // A space ends a bare query, but `@"My pa` legitimately contains spaces.
  const openQuoted = /@"[^"\n]*$/.test(text.slice(0, caret))
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      if (i > 0 && !/[\s(*]/.test(text[i - 1])) return null
      const body = text.slice(i + 1, caret)
      if (body.startsWith('"')) {
        const inner = body.slice(1)
        if (/["\n]/.test(inner)) return null
        return { start: i, query: inner, quoted: true }
      }
      if (/\s/.test(body)) return null
      return { start: i, query: body, quoted: false }
    }
    if (ch === '\n') return null
    if (/\s/.test(ch) && !openQuoted) return null
  }
  return null
}

/**
 * Replace the mention being typed with the formatted token plus one space.
 * Also swallows the rest of a bare word right of the caret, so accepting in
 * the middle of `@swa|rmterm` does not leave `rmterm` dangling.
 */
export function acceptMention(
  text: string,
  active: ActiveMention,
  caret: number,
  name: string
): { text: string; caret: number } {
  let end = caret
  if (active.quoted) {
    const close = text.indexOf('"', caret)
    const nl = text.indexOf('\n', caret)
    if (close >= 0 && (nl < 0 || close < nl)) end = close + 1
  } else {
    while (end < text.length && !/\s/.test(text[end])) end++
  }
  const token = formatMention(name)
  const after = text.slice(end)
  const sep = after.startsWith(' ') ? '' : ' '
  const next = text.slice(0, active.start) + token + sep + after
  return { text: next, caret: active.start + token.length + 1 }
}

// ---------------------------------------------------------------------------
// Popup keyboard

export type MentionKeyAction =
  | { type: 'move'; index: number }
  | { type: 'accept'; index: number }
  | { type: 'close' }
  | { type: 'pass' }

/**
 * What a keydown does while the popup is open. `pass` hands the key to the
 * textarea's normal handling (so Enter with no matches still sends). IME
 * composition always passes: Enter there commits the composition.
 */
export function mentionKeyAction(
  key: string,
  opts: { count: number; index: number; composing: boolean; shift?: boolean }
): MentionKeyAction {
  const { count, index, composing } = opts
  if (composing) return { type: 'pass' }
  if (key === 'Escape') return { type: 'close' }
  if (count === 0) return { type: 'pass' }
  if (key === 'ArrowDown') return { type: 'move', index: (index + 1) % count }
  if (key === 'ArrowUp') return { type: 'move', index: (index - 1 + count) % count }
  // Shift+Tab stays focus navigation, so the popup never traps the keyboard.
  if ((key === 'Enter' || key === 'Tab') && !opts.shift) return { type: 'accept', index }
  return { type: 'pass' }
}

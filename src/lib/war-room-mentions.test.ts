import { describe, expect, it } from 'vitest'
import {
  acceptMention,
  activeMention,
  buildCandidates,
  formatMention,
  matchCandidates,
  mentionKeyAction,
  mentionedIds,
  resolveMention,
  tokenizeMentions,
  type MentionCandidate
} from './war-room-mentions'

const c = (id: string, name: string): MentionCandidate => ({ id, name, kind: 'peer', agentId: null })

describe('buildCandidates', () => {
  it('lists members first, then named panes, skipping unnamed and duplicates by id', () => {
    const out = buildCandidates(
      [{ terminalId: 't1', name: 'claude-1', agentId: 'claude' }],
      [
        { terminalId: 't1', name: 'mine', agentId: 'claude', workspaceName: 'W' },
        { terminalId: 't2', name: 'build', workspaceName: 'W' },
        { terminalId: 't3', agentId: 'codex', workspaceName: 'W' },
        { terminalId: 't4', name: 'rev', agentId: 'codex', workspaceName: 'W' }
      ]
    )
    expect(out.map((x) => [x.id, x.kind])).toEqual([
      ['t1', 'peer'],
      ['t2', 'shell'],
      ['t4', 'agent']
    ])
    expect(out.every((x) => x.hint === undefined)).toBe(true)
  })

  it('adds hints only to duplicate names', () => {
    const out = buildCandidates(
      [{ terminalId: 't1', name: 'api', agentId: null }],
      [{ terminalId: 't2', name: 'API', workspaceName: 'Back' }]
    )
    expect(out.map((x) => x.hint)).toEqual(['War Room', 'Back'])
  })
})

describe('matchCandidates', () => {
  const list = [c('a', 'my-swarmterm'), c('b', 'Swarmterm'), c('c', 'sxwxa'), c('d', 'other'), c('e', 'reSwarm')]

  it('ranks prefix, then word start, then substring, then fuzzy', () => {
    expect(matchCandidates(list, 'swa').map((m) => m.candidate.id)).toEqual(['b', 'a', 'e', 'c'])
  })

  it('returns highlight ranges', () => {
    const [b, a] = matchCandidates(list, 'SWA')
    expect(b.ranges).toEqual([[0, 3]])
    expect(a.ranges).toEqual([[3, 6]])
    expect(matchCandidates([c('x', 'sxwxa')], 'swa')[0].ranges).toEqual([[0, 1], [2, 3], [4, 5]])
  })

  it('keeps candidate order for an empty query and caps the list', () => {
    const many = Array.from({ length: 12 }, (_, i) => c(String(i), `n${i}`))
    expect(matchCandidates(many, '').map((m) => m.candidate.id)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7'])
  })

  it('matches camelCase word starts', () => {
    expect(matchCandidates([c('x', 'buildBot')], 'bot')[0].tier).toBe(1)
  })
})

describe('formatMention / tokenizeMentions', () => {
  it('quotes names with spaces and escapes quotes and backslashes', () => {
    expect(formatMention('swarmterm-1')).toBe('@swarmterm-1')
    expect(formatMention('My pane')).toBe('@"My pane"')
    expect(formatMention('a "b" \\c')).toBe('@"a \\"b\\" \\\\c"')
  })

  it('round-trips every formatted name', () => {
    for (const n of ['x', 'My pane', 'a "b" \\c', 'ünï.code']) {
      expect(tokenizeMentions(`hi ${formatMention(n)} there`)).toEqual([
        { t: 'text', v: 'hi ' },
        { t: 'mention', name: n, raw: formatMention(n) },
        { t: 'text', v: ' there' }
      ])
    }
  })

  it('handles several mentions, trailing punctuation, e-mails and unclosed quotes', () => {
    expect(tokenizeMentions('@a and @b.')).toEqual([
      { t: 'mention', name: 'a', raw: '@a' },
      { t: 'text', v: ' and ' },
      { t: 'mention', name: 'b', raw: '@b' },
      { t: 'text', v: '.' }
    ])
    expect(tokenizeMentions('mail a@b.c')).toEqual([{ t: 'text', v: 'mail a@b.c' }])
    expect(tokenizeMentions('@"open')).toEqual([{ t: 'text', v: '@"open' }])
    expect(tokenizeMentions('@ alone')).toEqual([{ t: 'text', v: '@ alone' }])
    expect(tokenizeMentions('line\n@x')[1]).toEqual({ t: 'mention', name: 'x', raw: '@x' })
  })
})

describe('resolveMention / mentionedIds', () => {
  const list = [c('1', 'api'), c('2', 'API'), c('3', 'swarmterm'), c('4', 'swarmbot')]

  it('resolves exact case-insensitive, then unique prefix', () => {
    expect(resolveMention('SWARMTERM', list)).toEqual({ status: 'resolved', id: '3' })
    expect(resolveMention('swarmt', list)).toEqual({ status: 'resolved', id: '3' })
    expect(resolveMention('swarm', list)).toEqual({ status: 'unresolved' })
    expect(resolveMention('nobody', list)).toEqual({ status: 'unresolved' })
  })

  it('reports duplicates as ambiguous', () => {
    expect(resolveMention('api', list)).toEqual({ status: 'ambiguous', ids: ['1', '2'] })
  })

  it('collects distinct resolved ids in order', () => {
    expect(mentionedIds('@swarmbot @swarmterm @swarmbot @api @x', list)).toEqual(['4', '3'])
  })
})

describe('activeMention / acceptMention', () => {
  it('opens at start or after whitespace only', () => {
    expect(activeMention('@sw', 3)).toEqual({ start: 0, query: 'sw', quoted: false })
    expect(activeMention('hi\n@sw', 6)).toEqual({ start: 3, query: 'sw', quoted: false })
    expect(activeMention('a@sw', 4)).toBeNull()
    expect(activeMention('@sw x', 5)).toBeNull()
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '', quoted: false })
    expect(activeMention('no', 2)).toBeNull()
  })

  it('tracks an open quoted query with spaces', () => {
    expect(activeMention('x @"My pa', 9)).toEqual({ start: 2, query: 'My pa', quoted: true })
    expect(activeMention('@"done" x', 9)).toBeNull()
  })

  it('is caret based (mid-text)', () => {
    const t = 'ask @sw about it'
    expect(activeMention(t, 7)).toEqual({ start: 4, query: 'sw', quoted: false })
    expect(activeMention(t, 2)).toBeNull()
  })

  it('accepts with a trailing space and swallows the rest of the word', () => {
    const t = 'ask @swa|rm about'.replace('|', '')
    const a = activeMention(t, 8)!
    expect(acceptMention(t, a, 8, 'swarmterm')).toEqual({ text: 'ask @swarmterm about', caret: 15 })
    expect(acceptMention('@sw', activeMention('@sw', 3)!, 3, 'My pane')).toEqual({ text: '@"My pane" ', caret: 11 })
  })

  it('supports a second mention in the same message', () => {
    const t = '@a hi @b'
    const r = acceptMention(t, activeMention(t, 8)!, 8, 'bob')
    expect(r.text).toBe('@a hi @bob ')
  })
})

describe('mentionKeyAction', () => {
  const o = { count: 3, index: 0, composing: false }
  it('moves with wrap, accepts on Enter/Tab, closes on Esc', () => {
    expect(mentionKeyAction('ArrowDown', o)).toEqual({ type: 'move', index: 1 })
    expect(mentionKeyAction('ArrowUp', o)).toEqual({ type: 'move', index: 2 })
    expect(mentionKeyAction('Enter', { ...o, index: 2 })).toEqual({ type: 'accept', index: 2 })
    expect(mentionKeyAction('Tab', o)).toEqual({ type: 'accept', index: 0 })
    expect(mentionKeyAction('Escape', o)).toEqual({ type: 'close' })
    expect(mentionKeyAction('a', o)).toEqual({ type: 'pass' })
  })
  it('passes Enter with no matches, during IME composition and with Shift', () => {
    expect(mentionKeyAction('Enter', { ...o, count: 0 })).toEqual({ type: 'pass' })
    expect(mentionKeyAction('Enter', { ...o, composing: true })).toEqual({ type: 'pass' })
    expect(mentionKeyAction('Enter', { ...o, shift: true })).toEqual({ type: 'pass' })
    expect(mentionKeyAction('Tab', { ...o, shift: true })).toEqual({ type: 'pass' })
  })
})

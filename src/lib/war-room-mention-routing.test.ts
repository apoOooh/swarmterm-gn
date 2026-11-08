import { describe, expect, it, vi } from 'vitest'
import { EVERYONE } from './war-room-composer'
import { planSend, routableMentions, runSendPlan } from './war-room-mention-routing'
import { EVERYONE_CANDIDATE, buildCandidates, matchCandidates, resolveMention } from './war-room-mentions'

const m = (terminalId: string, name: string, agentId: string | null = 'claude', connected = true) => ({
  terminalId,
  name,
  agentId,
  connected
})
const members = [m('t1', 'developer'), m('t2', 'reviewer'), m('t3', 'Jörg'), m('t4', 'shell', null)]
const panes = [{ terminalId: 'p9', name: 'outsider', workspaceName: 'W' }]
const plan = (text: string, extra: Partial<Parameters<typeof planSend>[0]> = {}) =>
  planSend({ text, targetId: EVERYONE, mode: 'probe', members, panes: () => panes, ...extra })

describe('routableMentions', () => {
  it('ignores code spans, fenced blocks and e-mail-like tokens', () => {
    expect(routableMentions('hi @a `@b` a@c **@d**\n```\n@e\n```')).toEqual(['a', 'd'])
  })
})

describe('planSend', () => {
  it('no mention: unchanged picker send (broadcast or target)', () => {
    expect(plan('hello')).toEqual({ ok: true, calls: [{ to: null }], recipients: { kind: 'picker' } })
    expect(plan('hello', { targetId: 't2' })).toMatchObject({ ok: true, calls: [{ to: 't2' }] })
    expect(plan('  ')).toEqual({ ok: false, reason: 'Message is empty.' })
  })

  it('one and many mentions go only to those peers, duplicates once, case-insensitive', () => {
    expect(plan('@Developer do X', { targetId: 't2' })).toMatchObject({ ok: true, calls: [{ to: 't1' }] })
    expect(plan('@reviewer @developer check, @REVIEWER too')).toEqual({
      ok: true,
      calls: [{ to: 't2' }, { to: 't1' }],
      recipients: { kind: 'mentioned', ids: ['t2', 't1'] }
    })
  })

  it('resolves unique prefixes and unicode names', () => {
    expect(plan('@rev hi')).toMatchObject({ calls: [{ to: 't2' }] })
    expect(plan('@jörg hi')).toMatchObject({ calls: [{ to: 't3' }] })
  })

  it('blocks unresolved, non-peer and mixed messages without partial send', () => {
    expect(plan('@nobody hi')).toEqual({ ok: false, reason: 'Not sent — @nobody not found.' })
    expect(plan('@outsider hi')).toEqual({ ok: false, reason: 'Not sent — @outsider is not in the War Room.' })
    const mixed = plan('@developer @nobody hi')
    expect(mixed.ok).toBe(false)
  })

  it('never reaches a member by prefix when a non-member pane has the exact name', () => {
    const r = plan('@api do X', {
      members: [m('m1', 'api2')],
      panes: () => [{ terminalId: 'p1', name: 'api', workspaceName: 'W' }]
    })
    expect(r).toEqual({ ok: false, reason: 'Not sent — @api is not in the War Room.' })
  })

  it('reads panes only when member mentions need resolving', () => {
    const panesFn = vi.fn(() => panes)
    plan('hello', { panes: panesFn })
    plan('@everyone hi', { panes: panesFn })
    expect(panesFn).not.toHaveBeenCalled()
  })

  it('blocks a multi-recipient execute', () => {
    expect(plan('@developer @reviewer run', { mode: 'execute' })).toEqual({
      ok: false,
      reason: 'Execute runs in one terminal — mention a single agent.'
    })
    expect(plan('@developer run', { mode: 'execute' })).toMatchObject({ ok: true, calls: [{ to: 't1' }] })
  })

  it('uses the real preceding character as the @ boundary', () => {
    expect(routableMentions('x`code`@a b**@c**')).toEqual(['a', 'c'])
    expect(routableMentions('mail`x`a@b')).toEqual([])
  })

  it('blocks ambiguous names and ineligible members', () => {
    const dup = [m('a', 'api'), m('b', 'API')]
    expect(plan('@api x', { members: dup }).ok).toBe(false)
    expect(plan('@shell ls', { mode: 'execute' }).ok).toBe(false)
    expect(plan('@developer x', { members: [m('t1', 'developer', 'claude', false)] }).ok).toBe(false)
  })

  it('@everyone wins over other mentions and equals the no-mention broadcast', () => {
    const broadcast = plan('hi')
    const all = plan('@developer @reviewer hm, @Everyone please')
    expect(all).toEqual({ ok: true, calls: [{ to: null }], recipients: { kind: 'everyone', peers: 4 } })
    expect(all.ok && broadcast.ok && all.calls).toEqual(broadcast.ok && broadcast.calls)
    expect(plan('@EVERYONE @nobody x').ok).toBe(true)
  })

  it('@everyone counts connected peers and blocks an empty room or execute', () => {
    expect(plan('@everyone x', { members: [m('a', 'a'), m('b', 'b', 'x', false)] })).toMatchObject({
      recipients: { kind: 'everyone', peers: 1 }
    })
    expect(plan('@everyone x', { members: [] })).toEqual({
      ok: false,
      reason: '@everyone: no connected agents in the War Room yet.'
    })
    expect(plan('@everyone x', { mode: 'execute' }).ok).toBe(false)
  })
})

describe('reserved @everyone', () => {
  it('is never shadowed by a pane or member named everyone', () => {
    const cands = buildCandidates([m('e', 'Everyone')], [{ terminalId: 'p', name: 'everyone', workspaceName: 'W' }])
    expect(cands).toEqual([])
    expect(resolveMention('EVERYONE', [{ id: 'e', name: 'everyone', kind: 'peer', agentId: null }])).toEqual({
      status: 'resolved',
      id: EVERYONE_CANDIDATE.id
    })
    expect(plan('@everyone x', { members: [m('e', 'everyone'), m('t1', 'dev')] })).toMatchObject({
      calls: [{ to: null }]
    })
  })

  it('is offered first and completes from a prefix', () => {
    const list = [EVERYONE_CANDIDATE, ...buildCandidates(members, panes)]
    expect(matchCandidates(list, '')[0].candidate).toBe(EVERYONE_CANDIDATE)
    expect(matchCandidates(list, 'ever')[0].candidate).toBe(EVERYONE_CANDIDATE)
    expect(matchCandidates(list, '').map((x) => x.candidate.kind)).toEqual([
      'everyone', 'peer', 'peer', 'peer', 'peer', 'shell'
    ])
  })
})

describe('runSendPlan', () => {
  const base = { roomId: 'r', content: 'hi', mode: 'probe' as const }

  it('no mention: exactly the pre-feature call', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const p = plan('hi')
    if (!p.ok) throw new Error('plan')
    await runSendPlan(p.calls, base, send)
    expect(send.mock.calls).toEqual([[{ roomId: 'r', to: null, content: 'hi', mode: 'probe' }]])
  })

  it('passes exactly the mentioned recipient ids, in order', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const p = plan('@reviewer @developer go')
    if (!p.ok) throw new Error('plan')
    await runSendPlan(p.calls, base, send)
    expect(send.mock.calls.map((c) => c[0].to)).toEqual(['t2', 't1'])
  })

  it('stops at the first failure and says how many went out', async () => {
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce('boom')
    await expect(runSendPlan([{ to: 'a' }, { to: 'b' }, { to: 'c' }], base, send)).rejects.toThrow(
      'boom (already delivered to 1 of 3)'
    )
    expect(send).toHaveBeenCalledTimes(2)
  })
})

import { describe, expect, it } from 'vitest'
import { carryBlockedReason, carryResumePanes, retargetResumePanes } from './session-transfer'

const pane = (sessionId: string, accountId?: string) => ({ agentId: 'claude-code', sessionId, cwd: 'C:/w', accountId })

describe('retargetResumePanes', () => {
  it('moves only panes whose chosen subscription differs and remembers the source', () => {
    const out = retargetResumePanes([pane('a', 'p1'), pane('b'), pane('c', 'p1')], { a: 'p2', b: 'p1', c: 'p1' }, p => p.sessionId)
    expect(out).toEqual([
      { ...pane('a', 'p2'), fromAccountId: 'p1' },
      { ...pane('b', 'p1'), fromAccountId: undefined },
      pane('c', 'p1')
    ])
  })

  it('null targets the default profile and missing entries keep the session where it is', () => {
    const out = retargetResumePanes([pane('a', 'p1'), pane('b', 'p1')], { a: null }, p => p.sessionId)
    expect(out).toEqual([{ ...pane('a', undefined), fromAccountId: 'p1' }, pane('b', 'p1')])
  })
})

describe('carryBlockedReason', () => {
  it('blocks only while the agent is mid-turn or waiting on the user', () => {
    expect(carryBlockedReason('working')).toMatch(/working/)
    expect(carryBlockedReason('blocked')).toMatch(/answer/)
    expect(carryBlockedReason('idle')).toBeUndefined()
    expect(carryBlockedReason('unknown')).toBeUndefined()
    expect(carryBlockedReason(undefined)).toBeUndefined()
  })
})

describe('carryResumePanes', () => {
  it('copies moved panes, leaves the rest, and keeps a failed copy on its original subscription', async () => {
    const calls: string[] = []
    const transfer = async (_a: string, id: string, from?: string, to?: string): Promise<void> => {
      calls.push(`${id}:${from ?? 'default'}->${to ?? 'default'}`)
      if (id === 'bad') throw new Error('disk full')
    }
    const { panes, failed } = await carryResumePanes([
      { ...pane('ok', 'p2'), moved: true, fromAccountId: 'p1' },
      { ...pane('bad', 'p2'), moved: true, fromAccountId: undefined },
      { ...pane('stay', 'p1'), moved: false }
    ], transfer)
    expect(calls).toEqual(['ok:p1->p2', 'bad:default->p2'])
    expect(panes).toEqual([pane('ok', 'p2'), pane('bad', undefined), pane('stay', 'p1')])
    expect(failed).toEqual(['Error: disk full'])
  })
})

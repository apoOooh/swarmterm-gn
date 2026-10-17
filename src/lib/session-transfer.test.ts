import { describe, expect, it } from 'vitest'
import { retargetResumePanes } from './session-transfer'

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

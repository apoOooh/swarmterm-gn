import { describe, expect, it } from 'vitest'
import { turnEventFor } from './voice-turns'

describe('turnEventFor', () => {
  it('maps attention and completion to the pipe kinds', () => {
    expect(turnEventFor({ terminalId: 't1', kind: 'attention', agentId: 'claude-code' }, 'Refactor')).toEqual({
      terminalId: 't1', kind: 'needs_input', paneName: 'Refactor', agent: 'claude-code'
    })
    expect(turnEventFor({ terminalId: 't2', kind: 'completion', agentId: 'codex' }, '')).toEqual({
      terminalId: 't2', kind: 'done', paneName: 'Codex', agent: 'codex'
    })
  })

  it('never announces a hand-typed command', () => {
    expect(turnEventFor({ terminalId: 's', kind: 'command', agentId: 'terminal' }, 'x')).toBeNull()
  })
})

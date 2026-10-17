import { describe, expect, it } from 'vitest'
import { turnEventFor, turnKindEntry } from './voice-turns'

describe('turnEventFor', () => {
  it('maps attention and completion to the pipe kinds', () => {
    expect(turnEventFor({ terminalId: 't1', kind: 'attention', agentId: 'claude-code', watched: false }, 'Refactor')).toEqual({
      terminalId: 't1', kind: 'needs_input', paneName: 'Refactor', agent: 'claude-code', watched: false
    })
    expect(turnEventFor({ terminalId: 't2', kind: 'completion', agentId: 'codex', watched: false }, '')).toEqual({
      terminalId: 't2', kind: 'done', paneName: 'Codex', agent: 'codex', watched: false
    })
  })

  it('passes the watched flag on (SWA-58: Rust speaks only a reply then)', () => {
    expect(turnEventFor({ terminalId: 't1', kind: 'completion', agentId: 'claude-code', watched: true }, 'X')?.watched).toBe(true)
  })

  it('never announces a hand-typed command', () => {
    expect(turnEventFor({ terminalId: 's', kind: 'command', agentId: 'terminal', watched: false }, 'x')).toBeNull()
  })
})

describe('turnKindEntry (SWA-58)', () => {
  it('files error and interrupted turns for the bell, ids and pane title only', () => {
    expect(turnKindEntry({ terminalId: 't1', kind: 'error' }, 'Backend', 5)).toEqual({
      kind: 'error', terminalId: 't1', title: 'Agent turn failed', detail: 'Backend', at: 5
    })
    expect(turnKindEntry({ terminalId: 't1', kind: 'interrupted' }, '', 6)).toEqual({
      kind: 'interrupted', terminalId: 't1', title: 'Agent turn interrupted', detail: '', at: 6
    })
  })
})

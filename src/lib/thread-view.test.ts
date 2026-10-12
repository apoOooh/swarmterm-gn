import { describe, expect, it } from 'vitest'
import { canShowThread, threadItems, threadTime } from './thread-view'

describe('canShowThread', () => {
  it('needs a supported agent and a session id', () => {
    expect(canShowThread('claude-code', 'abc')).toBe(true)
    expect(canShowThread('codex', 'abc')).toBe(true)
    expect(canShowThread('claude-code', undefined)).toBe(false)
    expect(canShowThread('opencode', 'abc')).toBe(false)
    expect(canShowThread('terminal', 'abc')).toBe(false)
  })
})

describe('threadItems', () => {
  const msgs = [
    { role: 'user' as const, text: 'Fix it', at: '2026-10-12T10:00:00Z' },
    { role: 'tool' as const, text: '→ Read' },
    { role: 'tool' as const, text: '← tool result' },
    { role: 'assistant' as const, text: 'Done' },
    { role: 'tool' as const, text: '→ Edit' }
  ]

  it('collapses consecutive tool steps into one row', () => {
    expect(threadItems(msgs, true)).toEqual([
      { kind: 'message', role: 'user', text: 'Fix it', at: '2026-10-12T10:00:00Z' },
      { kind: 'tools', steps: ['→ Read', '← tool result'] },
      { kind: 'message', role: 'assistant', text: 'Done', at: undefined },
      { kind: 'tools', steps: ['→ Edit'] }
    ])
  })

  it('drops tools when hidden', () => {
    expect(threadItems(msgs, false).map((i) => i.kind)).toEqual(['message', 'message'])
  })
})

describe('threadTime', () => {
  it('is empty for missing or invalid stamps', () => {
    expect(threadTime(undefined)).toBe('')
    expect(threadTime('nope')).toBe('')
    expect(threadTime('2026-10-12T10:00:00Z')).toMatch(/\d{2}:\d{2}/)
  })
})

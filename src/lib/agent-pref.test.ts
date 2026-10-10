import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AGENT_STORAGE_KEY,
  isKnownAgentId,
  readStoredDefaultAgent,
  resolveSplitAgent,
  storeDefaultAgent,
  type AgentPrefStorage
} from './agent-pref'

function fakeStorage(initial: Record<string, string> = {}): AgentPrefStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

describe('stored default agent', () => {
  it('defaults to a plain terminal when nothing is stored', () => {
    expect(readStoredDefaultAgent(fakeStorage())).toBe('terminal')
  })

  it('reads a known agent id', () => {
    expect(readStoredDefaultAgent(fakeStorage({ [DEFAULT_AGENT_STORAGE_KEY]: 'codex' }))).toBe('codex')
  })

  it('falls back to terminal for an unknown id', () => {
    expect(readStoredDefaultAgent(fakeStorage({ [DEFAULT_AGENT_STORAGE_KEY]: 'nope' }))).toBe('terminal')
  })

  it('round-trips through storeDefaultAgent', () => {
    const s = fakeStorage()
    storeDefaultAgent(s, 'claude-code')
    expect(readStoredDefaultAgent(s)).toBe('claude-code')
  })

  it('isKnownAgentId is exact', () => {
    expect(isKnownAgentId('codex')).toBe(true)
    expect(isKnownAgentId('Codex')).toBe(false)
    expect(isKnownAgentId(undefined)).toBe(false)
  })
})

describe('resolveSplitAgent', () => {
  it('uses the global default when the workspace has none', () => {
    expect(resolveSplitAgent({ globalDefault: 'codex', availability: {} })).toBe('codex')
  })

  it('prefers the workspace default over the global one', () => {
    expect(resolveSplitAgent({ workspaceDefault: 'claude-code', globalDefault: 'codex', availability: {} })).toBe(
      'claude-code'
    )
  })

  it('a workspace default of terminal overrides a global agent', () => {
    expect(resolveSplitAgent({ workspaceDefault: 'terminal', globalDefault: 'codex', availability: {} })).toBe('terminal')
  })

  it('ignores an unknown workspace default', () => {
    expect(resolveSplitAgent({ workspaceDefault: 'bogus', globalDefault: 'codex', availability: {} })).toBe('codex')
  })

  it('falls back to terminal when the agent CLI is not installed', () => {
    expect(resolveSplitAgent({ globalDefault: 'codex', availability: { codex: false } })).toBe('terminal')
  })

  it('forcePlain always yields a plain shell', () => {
    expect(
      resolveSplitAgent({ workspaceDefault: 'codex', globalDefault: 'claude-code', availability: {}, forcePlain: true })
    ).toBe('terminal')
  })
})

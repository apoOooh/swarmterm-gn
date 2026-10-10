import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AGENT_STORAGE_KEY,
  DEFAULT_LAUNCH_MODES_STORAGE_KEY,
  readStoredLaunchModes,
  resolveLaunchMode,
  storeLaunchModes,
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

describe('stored launch modes', () => {
  it('is empty when nothing or garbage is stored', () => {
    expect(readStoredLaunchModes(fakeStorage())).toEqual({})
    expect(readStoredLaunchModes(fakeStorage({ [DEFAULT_LAUNCH_MODES_STORAGE_KEY]: '{nope' }))).toEqual({})
    expect(readStoredLaunchModes(fakeStorage({ [DEFAULT_LAUNCH_MODES_STORAGE_KEY]: '[1]' }))).toEqual({})
  })

  it('drops unknown agents, modeless agents and unknown modes', () => {
    const raw = JSON.stringify({ 'claude-code': 'plan', codex: 'nope', gone: 'yolo', opencode: 'yolo' })
    expect(readStoredLaunchModes(fakeStorage({ [DEFAULT_LAUNCH_MODES_STORAGE_KEY]: raw }))).toEqual({
      'claude-code': 'plan'
    })
  })

  it('round-trips through storage', () => {
    const storage = fakeStorage()
    storeLaunchModes(storage, { 'claude-code': 'bypass', codex: 'safe' })
    expect(readStoredLaunchModes(storage)).toEqual({ 'claude-code': 'bypass', codex: 'safe' })
  })
})

describe('resolveLaunchMode', () => {
  it('prefers the pane choice, then the Settings default, then the first mode', () => {
    expect(resolveLaunchMode('claude-code', 'plan', { 'claude-code': 'bypass' })).toBe('plan')
    expect(resolveLaunchMode('claude-code', undefined, { 'claude-code': 'bypass' })).toBe('bypass')
    expect(resolveLaunchMode('claude-code', undefined, {})).toBe('default')
    expect(resolveLaunchMode('codex', 'nope', { codex: 'safe' })).toBe('safe')
  })

  it('is undefined for agents without modes', () => {
    expect(resolveLaunchMode('opencode', undefined, {})).toBeUndefined()
    expect(resolveLaunchMode('terminal', undefined, {})).toBeUndefined()
    expect(resolveLaunchMode(undefined, undefined, {})).toBeUndefined()
  })
})

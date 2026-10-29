import { describe, it, expect } from 'vitest'
import { dangerousModeWarning, isDangerousLaunchMode, workerLaunchMode } from './launch-mode-safety'

describe('isDangerousLaunchMode', () => {
  it('flags Claude bypass and Auto and Codex YOLO only', () => {
    expect(isDangerousLaunchMode('claude-code', 'bypass')).toBe(true)
    expect(isDangerousLaunchMode('codex', 'yolo')).toBe(true)
    expect(isDangerousLaunchMode('claude-code', 'default')).toBe(false)
    expect(isDangerousLaunchMode('claude-code', 'auto')).toBe(true)
    expect(isDangerousLaunchMode('claude-code', 'plan')).toBe(false)
    expect(isDangerousLaunchMode('codex', 'auto')).toBe(false)
  })

  it('is false for unknown ids and agents without modes', () => {
    expect(isDangerousLaunchMode('claude-code', 'nope')).toBe(false)
    expect(isDangerousLaunchMode('terminal', 'bypass')).toBe(false)
    expect(isDangerousLaunchMode(undefined, undefined)).toBe(false)
  })
})

describe('dangerousModeWarning', () => {
  it('names the mode and the risk for a dangerous mode', () => {
    const w = dangerousModeWarning('claude-code', 'bypass')
    expect(w?.title).toContain('Bypass permissions')
    expect(w?.body).toMatch(/without asking/)
  })

  it('explains that Claude Auto hands approval to its classifier', () => {
    const w = dangerousModeWarning('claude-code', 'auto')
    expect(w?.title).toContain('Auto')
    expect(w?.body).toMatch(/classifier/)
  })

  it('never lets a worker inherit Claude Auto without the opt-in', () => {
    expect(
      workerLaunchMode({ agentId: 'claude-code', requesterAgentId: 'claude-code', requesterMode: 'auto', prefs: { 'claude-code': 'auto' } })
    ).toBe('default')
    expect(
      workerLaunchMode({
        agentId: 'claude-code',
        requesterAgentId: 'claude-code',
        requesterMode: 'auto',
        prefs: {},
        inheritBypass: true
      })
    ).toBe('auto')
  })

  it('is undefined for a safe mode', () => {
    expect(dangerousModeWarning('codex', 'auto')).toBeUndefined()
  })
})

describe('workerLaunchMode', () => {
  it('never inherits a bypass requester mode: falls back to the template default', () => {
    expect(
      workerLaunchMode({ agentId: 'claude-code', requesterAgentId: 'claude-code', requesterMode: 'bypass', prefs: {} })
    ).toBe('default')
    expect(workerLaunchMode({ agentId: 'codex', requesterAgentId: 'codex', requesterMode: 'yolo', prefs: {} })).toBe(
      'auto'
    )
  })

  it('uses the settings default when the requester is bypassed and the default is safe', () => {
    expect(
      workerLaunchMode({
        agentId: 'claude-code',
        requesterAgentId: 'claude-code',
        requesterMode: 'bypass',
        prefs: { 'claude-code': 'acceptEdits' }
      })
    ).toBe('acceptEdits')
  })

  it('ignores a dangerous settings default too', () => {
    expect(
      workerLaunchMode({ agentId: 'claude-code', requesterAgentId: 'claude-code', prefs: { 'claude-code': 'bypass' } })
    ).toBe('default')
    expect(workerLaunchMode({ agentId: 'codex', requesterAgentId: 'claude-code', prefs: { codex: 'yolo' } })).toBe('auto')
  })

  it('keeps a safe requester mode for a same-agent worker', () => {
    expect(
      workerLaunchMode({ agentId: 'claude-code', requesterAgentId: 'claude-code', requesterMode: 'plan', prefs: {} })
    ).toBe('plan')
  })

  it('does not carry a mode across agents (mode ids are per-agent)', () => {
    expect(
      workerLaunchMode({ agentId: 'codex', requesterAgentId: 'claude-code', requesterMode: 'auto', prefs: { codex: 'safe' } })
    ).toBe('safe')
  })

  it('is undefined for agents without modes', () => {
    expect(workerLaunchMode({ agentId: 'terminal', requesterAgentId: 'terminal', prefs: {} })).toBeUndefined()
    expect(workerLaunchMode({ agentId: undefined, prefs: {} })).toBeUndefined()
  })
})

describe('workerLaunchMode with inheritBypass', () => {
  it('inherits a dangerous requester mode of the same agent when opted in', () => {
    expect(
      workerLaunchMode({
        agentId: 'claude-code',
        requesterAgentId: 'claude-code',
        requesterMode: 'bypass',
        prefs: {},
        inheritBypass: true
      })
    ).toBe('bypass')
    expect(
      workerLaunchMode({ agentId: 'codex', requesterAgentId: 'codex', requesterMode: 'yolo', prefs: {}, inheritBypass: true })
    ).toBe('yolo')
  })

  it('never inherits across agents or from a dangerous Settings default', () => {
    expect(
      workerLaunchMode({
        agentId: 'codex',
        requesterAgentId: 'claude-code',
        requesterMode: 'bypass',
        prefs: { codex: 'yolo' },
        inheritBypass: true
      })
    ).toBe('auto')
  })

  it('ignores an unknown requester mode', () => {
    expect(
      workerLaunchMode({
        agentId: 'claude-code',
        requesterAgentId: 'claude-code',
        requesterMode: 'nope',
        prefs: {},
        inheritBypass: true
      })
    ).toBe('default')
  })
})

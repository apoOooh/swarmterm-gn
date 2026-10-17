import { describe, expect, it } from 'vitest'
import { agentNewlineFor, isShiftEnter } from '@/lib/agent-newline'

const key = (over: Partial<KeyboardEvent> = {}) => ({ key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, ...over }) as KeyboardEvent

describe('agentNewlineFor', () => {
  it('sends LF for Shift+Enter in an agent pane', () => {
    expect(agentNewlineFor(key(), 'claude-code')).toBe('\n')
    expect(agentNewlineFor(key(), 'codex')).toBe('\n')
  })
  it('leaves plain shells and unknown panes to xterm', () => {
    expect(agentNewlineFor(key(), 'terminal')).toBeNull()
    expect(agentNewlineFor(key(), undefined)).toBeNull()
  })
  it('ignores plain Enter and other modifier combos', () => {
    expect(agentNewlineFor(key({ shiftKey: false }), 'claude-code')).toBeNull()
    expect(agentNewlineFor(key({ ctrlKey: true }), 'claude-code')).toBeNull()
    expect(agentNewlineFor(key({ altKey: true }), 'claude-code')).toBeNull()
    expect(agentNewlineFor(key({ metaKey: true }), 'claude-code')).toBeNull()
    expect(agentNewlineFor(key({ key: 'a' }), 'claude-code')).toBeNull()
  })
  it('stays out of an IME composition', () => {
    expect(isShiftEnter({ ...key(), isComposing: true })).toBe(false)
  })
})

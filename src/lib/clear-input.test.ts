import { describe, expect, it } from 'vitest'
import { ClearGuard, CLEAR_COOLDOWN_MS, clearInputSequence } from './clear-input'
describe('clearInputSequence', () => {
  it('sends one Ctrl+C to agent TUIs', () => {
    expect(clearInputSequence('claude-code', 'powershell')).toBe('\x03')
    expect(clearInputSequence('codex', 'posix')).toBe('\x03')
  })
  it('uses the shell line-kill for plain terminals', () => {
    expect(clearInputSequence('terminal', 'powershell')).toBe('\x1b')
    expect(clearInputSequence(undefined, 'cmd')).toBe('\x1b')
    expect(clearInputSequence('terminal', 'posix')).toBe('\x05\x15')
  })
})
describe('ClearGuard', () => {
  it('never lets two clears of one pane through inside the cooldown', () => {
    const g = new ClearGuard()
    expect(g.allow('a', 0)).toBe(true)
    expect(g.allow('a', CLEAR_COOLDOWN_MS - 1)).toBe(false)
    expect(g.allow('b', 10)).toBe(true)
    expect(g.allow('a', CLEAR_COOLDOWN_MS)).toBe(true)
  })
})

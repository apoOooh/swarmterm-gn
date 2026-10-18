import { expect, it } from 'vitest'
import { allocateAccounts, splitAccountFor, workspaceAccountSelections } from './agent-accounts'
import { sessionKey, mergeSessions } from './agent-sessions'
import type { AgentAccount } from '@/tauri/accounts'

const accounts: AgentAccount[] = [
  { id: 'claude-a', agentId: 'claude-code', name: 'A', configDir: 'C:/isolated/a' },
  { id: 'claude-b', agentId: 'claude-code', name: 'B', configDir: 'C:/isolated/b' },
  { id: 'codex-c', agentId: 'codex', name: 'C', configDir: 'C:/isolated/c' }
]
it('rotates independently per CLI including its default, never lending another CLI profile', () => {
  expect(allocateAccounts(['claude-code', 'codex', 'claude-code', 'terminal', 'codex', 'claude-code', 'claude-code'], accounts, { 'claude-code': { mode: 'round-robin' }, codex: { mode: 'round-robin' } })).toEqual([undefined, undefined, 'claude-a', undefined, 'codex-c', 'claude-b', undefined])
})
it('uses fixed profiles and falls back when a chosen profile was removed or belongs to another CLI', () => {
  expect(allocateAccounts(['claude-code', 'claude-code', 'codex'], accounts, { 'claude-code': { mode: 'fixed', accountId: 'claude-b' }, codex: { mode: 'fixed', accountId: 'claude-a' } })).toEqual(['claude-b', 'claude-b', undefined])
  expect(allocateAccounts(['codex'], [], { codex: { mode: 'fixed', accountId: 'gone' } })).toEqual([undefined])
})
it('picks a split pane account from the workspace choice, else the source pane', () => {
  const claude = (accountId?: string) => ({ agentId: 'claude-code', accountId })
  expect(splitAccountFor('claude-code', { mode: 'fixed', accountId: 'claude-b' }, accounts, [claude()], claude('claude-a'))).toBe('claude-b')
  expect(splitAccountFor('claude-code', { mode: 'round-robin' }, accounts, [claude(), { agentId: 'codex' }], claude())).toBe('claude-a')
  expect(splitAccountFor('claude-code', { mode: 'fixed', accountId: 'gone' }, accounts, [], claude('claude-a'))).toBe('claude-a')
  expect(splitAccountFor('claude-code', undefined, accounts, [], { agentId: 'codex', accountId: 'codex-c' })).toBeUndefined()
  expect(splitAccountFor('terminal', { mode: 'round-robin' }, accounts, [], claude('claude-a'))).toBeUndefined()
})
it('keeps only non-default workspace account choices', () => {
  expect(workspaceAccountSelections({ 'claude-code': { mode: 'fixed' }, codex: { mode: 'round-robin' } })).toEqual({ codex: { mode: 'round-robin' } })
  expect(workspaceAccountSelections({ 'claude-code': { mode: 'fixed' } })).toBeUndefined()
})
it('keeps identical session ids in different account stores separate', () => {
  const entry = { agentId: 'codex', sessionId: '018f3b2a-7c1d-4e0a-9b2f-1a2b3c4d5e6f', title: 'Conversation', cwd: 'C:/repo', updatedAtMs: 10 }
  const rows = [entry, { ...entry, accountId: 'codex-c' }]
  expect(sessionKey(rows[0])).not.toBe(sessionKey(rows[1]))
  expect(mergeSessions(rows, {})).toHaveLength(2)
})

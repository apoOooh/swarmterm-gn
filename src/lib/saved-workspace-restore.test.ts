import { expect, it } from 'vitest'
import { prepareSavedWorkspace } from './saved-workspace-restore'
import type { SavedWorkspace } from './saved-workspaces'

const id = '018f3b2a-7c1d-4e0a-9b2f-1a2b3c4d5e6f'
const saved: SavedWorkspace = { id: 'saved', name: 'Project', cwd: '/repo', worktreeMode: true, updatedAt: 1, layout: { type: 'leaf', agentId: 'codex', shellId: 'pwsh', cwd: '/repo.worktrees/test', worktreeBranch: 'test', sessionId: id } }
it('refuses a missing root without changing the saved entry', () => {
  expect(() => prepareSavedWorkspace(saved, { rootAvailable: false, panes: [] }, {}, {})).toThrow('Working folder')
  expect(saved.layout.type === 'leaf' && saved.layout.sessionId).toBe(id)
})
it('falls back from a deleted worktree, never resuming it at a different cwd', () => {
  const result = prepareSavedWorkspace(saved, { rootAvailable: true, panes: [{ directoryAvailable: false, sessionAvailable: true }] }, {}, {})
  expect(result.saved.layout).toMatchObject({ cwd: '/repo' })
  expect(result.saved.layout.type === 'leaf' && result.saved.layout.sessionId).toBeUndefined()
  expect(result.saved.layout.type === 'leaf' && result.saved.layout.worktreeBranch).toBeUndefined()
  expect(result.warnings).toHaveLength(1)
})
it('preserves a valid session and reports unavailable agents, shells and sessions', () => {
  const check = { rootAvailable: true, panes: [{ directoryAvailable: true, sessionAvailable: true }] }
  expect(prepareSavedWorkspace(saved, check, {}, {}).saved.layout).toEqual(saved.layout)
  const result = prepareSavedWorkspace(saved, { ...check, panes: [{ directoryAvailable: true, sessionAvailable: false }] }, { codex: false }, { pwsh: false })
  expect(result.saved.layout).toMatchObject({ agentId: 'terminal', shellId: 'default' })
  expect(result.saved.layout.type === 'leaf' && result.saved.layout.sessionId).toBeUndefined()
  expect(result.warnings.length).toBeGreaterThan(0)
})

it('never resumes an account session under a default account after profile deletion', () => {
  const snapshot = { ...saved, layout: { ...saved.layout, accountId: 'removed-profile' } }
  const result = prepareSavedWorkspace(snapshot, { rootAvailable: true, panes: [{ directoryAvailable: true, sessionAvailable: true, accountAvailable: false }] }, {}, {})
  expect(result.saved.layout.type === 'leaf' && result.saved.layout.accountId).toBeUndefined()
  expect(result.saved.layout.type === 'leaf' && result.saved.layout.sessionId).toBeUndefined()
  expect(result.warnings).toEqual(['A saved account is no longer available; its agent starts fresh with the default account.'])
})

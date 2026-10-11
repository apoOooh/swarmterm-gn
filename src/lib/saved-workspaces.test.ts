import { describe, expect, it } from 'vitest'
import { collectLeaves } from './layout-tree'
import { fromSaved, readSaved, toSaved, upsertSaved, SAVED_WORKSPACES_KEY, type SavedWorkspace } from './saved-workspaces'
import type { Workspace } from '@/store/app-store'

const session = '018f3b2a-7c1d-4e0a-9b2f-1a2b3c4d5e6f'
const workspace: Workspace = {
  id: 'live', savedId: 'saved', name: 'Project', cwd: 'C:/project', worktreeMode: true,
  focusedLeafId: 'a', broadcastActive: true, broadcastLeafIds: ['a'], zoomedLeafId: 'a',
  layout: { type: 'split', id: 'split', direction: 'horizontal', sizes: [30, 70], children: [
    { type: 'leaf', id: 'a', terminalId: 'ta', agentId: 'codex', sessionId: session, launchMode: 'safe', initialPrompt: 'private brief' },
    { type: 'leaf', id: 'b', terminalId: 'tb', cwd: 'C:/project.worktrees/test', worktreeBranch: 'test', startupCommand: 'private command' }
  ] }
}
function saved(): SavedWorkspace { return toSaved(workspace, 'powershell', 10)! }
function storage(raw: string | null) { return { getItem: (key: string) => key === SAVED_WORKSPACES_KEY ? raw : null } }

describe('saved workspace snapshots', () => {
  it('round-trips the exact split shape and resolved shell with fresh runtime ids', () => {
    let n = 0
    const restored = fromSaved(saved(), () => `new-${++n}`)
    expect(restored.savedId).toBe('saved')
    expect(restored.worktreeMode).toBe(true)
    expect(restored.layout.type === 'split' && restored.layout.sizes).toEqual([30, 70])
    const leaves = collectLeaves(restored.layout)
    expect(leaves[0]).toMatchObject({ agentId: 'codex', shellId: 'powershell', cwd: 'C:/project', resumeSessionId: session, sessionId: session, launchMode: 'safe' })
    expect(leaves[1]).toMatchObject({ agentId: 'terminal', worktreeBranch: 'test' })
    expect(new Set([restored.id, restored.layout.id, ...leaves.flatMap(l => [l.id, l.terminalId])]).size).toBe(6)
    expect(restored.broadcastActive).toBe(false)
    expect(restored.zoomedLeafId).toBeUndefined()
  })
  it('never persists runtime ids, brief text, startup commands or broadcast', () => {
    const value = JSON.stringify(saved())
    for (const field of ['terminalId', 'initialPrompt', 'startupCommand', 'broadcast', 'zoomedLeafId', 'private']) expect(value).not.toContain(field)
    expect(toSaved({ ...workspace, savedId: undefined }, 'default', 1)).toBeUndefined()
  })
  it('keeps an explicitly selected resume session, but rejects shell injection', () => {
    const single = { ...workspace, layout: { type: 'leaf' as const, id: 'a', terminalId: 'ta', agentId: 'claude-code', resumeSessionId: session } }
    expect(collectLeaves(fromSaved(toSaved(single, 'default', 1)!, () => crypto.randomUUID()).layout)[0].resumeSessionId).toBe(session)
    const bad = saved()
    if (bad.layout.type === 'split' && bad.layout.children[0].type === 'leaf') bad.layout.children[0].sessionId = 'id; run something'
    expect(collectLeaves(fromSaved(bad, () => crypto.randomUUID()).layout)[0].resumeSessionId).toBeUndefined()
  })
})

describe('saved workspace storage', () => {
  it('tolerates missing, broken and wrongly shaped storage', () => {
    for (const raw of [null, 'garbage', '{}', '[]', '{"version":1,"workspaces":false}']) expect(readSaved(storage(raw))).toEqual([])
  })
  it('validates whole trees and drops damaged entries independently', () => {
    const good = saved()
    const broken = { ...good, id: 'bad', layout: { type: 'split', direction: 'horizontal', sizes: [0, 100], children: [] } }
    expect(readSaved(storage(JSON.stringify({ version: 1, workspaces: [null, broken, good, good] })))).toEqual([good])
  })
  it('refuses to overwrite a storage format from a newer version', () => {
    expect(() => readSaved(storage('{"version":2,"workspaces":[]}'))).toThrow('newer')
  })
  it('upserts by stable id, sorts newest first and caps the list at 24', () => {
    let list: SavedWorkspace[] = []
    for (let i = 0; i < 30; i++) list = upsertSaved(list, { ...saved(), id: `saved-${i}`, updatedAt: i })
    expect(list).toHaveLength(24)
    expect(list[0].id).toBe('saved-29')
    list = upsertSaved(list, { ...saved(), id: 'saved-10', name: 'Renamed', updatedAt: 100 })
    expect(list[0].name).toBe('Renamed')
    expect(list.filter(w => w.id === 'saved-10')).toHaveLength(1)
  })
})

it('retains a session together with its profile across storage and restore while legacy entries use defaults', () => {
  const ws = { ...workspace, layout: { type: 'leaf' as const, id: 'a', terminalId: 'ta', agentId: 'codex', accountId: 'profile-a', sessionId: session } }
  const snapshot = toSaved(ws, 'default', 20)!
  const loaded = readSaved(storage(JSON.stringify({ version: 1, workspaces: [snapshot] })))[0]
  expect(collectLeaves(fromSaved(loaded, () => crypto.randomUUID()).layout)[0]).toMatchObject({ accountId: 'profile-a', sessionId: session, resumeSessionId: session })
  expect(collectLeaves(fromSaved(saved(), () => crypto.randomUUID()).layout)[0].accountId).toBeUndefined()
})

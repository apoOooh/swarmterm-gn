import { describe, expect, it } from 'vitest'
import { reattachResolver, savedPaneIds } from './host-reattach'
import type { SavedWorkspace } from './saved-workspaces'
import type { DetachedPane } from '@/tauri/terminal-host'

const ws = (id: string, ids: (string | undefined)[]): SavedWorkspace => ({
  id, name: id, cwd: 'C:/p', worktreeMode: false, updatedAt: 1,
  layout: ids.length === 1
    ? { type: 'leaf', agentId: 'terminal', shellId: 'default', cwd: 'C:/p', ...(ids[0] ? { terminalId: ids[0] } : {}) }
    : { type: 'split', direction: 'horizontal', sizes: [50, 50], children: ids.map(t => ({ type: 'leaf' as const, agentId: 'terminal', shellId: 'default' as const, cwd: 'C:/p', ...(t ? { terminalId: t } : {}) })) as [never, never] }
})
const pane = (terminalId: string, agentId: string | null = 'codex'): DetachedPane =>
  ({ terminalId, spawnId: 'g', pid: 1, cwd: 'C:/live', meta: { agentId } })

describe('savedPaneIds', () => {
  it('lists every pane id the saved workspaces reference', () => {
    expect(savedPaneIds([ws('a', ['t1', undefined]), ws('b', ['t3'])])).toEqual(['t1', 't3'])
  })
})

describe('reattachResolver', () => {
  it('reattaches a detached pane with the host-known agent and folder', () => {
    const resolve = reattachResolver([pane('t1')], [])
    expect(resolve({ type: 'leaf', agentId: 'terminal', shellId: 'default', cwd: 'C:/p', terminalId: 't1' }))
      .toEqual({ terminalId: 't1', agentId: 'codex', cwd: 'C:/live' })
  })

  it('treats a pane without an agent as a plain terminal', () => {
    const resolve = reattachResolver([pane('t1', null)], [])
    expect(resolve({ type: 'leaf', agentId: 'codex', shellId: 'default', cwd: 'C:/p', terminalId: 't1' })?.agentId).toBe('terminal')
  })

  it('never hands out an id twice or one an open workspace holds', () => {
    const resolve = reattachResolver([pane('t1'), pane('t2')], ['t2'])
    const leaf = (terminalId: string) => ({ type: 'leaf' as const, agentId: 'terminal', shellId: 'default' as const, cwd: 'C:/p', terminalId })
    expect(resolve(leaf('t1'))).toBeDefined()
    expect(resolve(leaf('t1'))).toBeUndefined()
    expect(resolve(leaf('t2'))).toBeUndefined()
    expect(resolve(leaf('nope'))).toBeUndefined()
  })

  it('ignores leaves without a saved id', () => {
    expect(reattachResolver([pane('t1')], [])({ type: 'leaf', agentId: 'terminal', shellId: 'default', cwd: 'C:/p' })).toBeUndefined()
  })
})

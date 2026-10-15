import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { appStoreCreator, type AppStore } from '@/store/app-store'
import { startSavedWorkspaceSync } from './saved-workspace-sync'
import { toSaved, type SavedWorkspace } from './saved-workspaces'
import { collectLeaves } from './layout-tree'

afterEach(() => vi.useRealTimers())
function setup() {
  vi.useFakeTimers()
  const app = createStore<AppStore>()(appStoreCreator)
  let list: SavedWorkspace[] = [], writes = 0
  const sync = startSavedWorkspaceSync({ app, shell: () => 'powershell', save: entries => { list = entries; writes++ } })
  return { app, sync, list: () => list, writes: () => writes }
}
describe('workspace auto-save lifecycle', () => {
  it('a shell preference change is saved on the next store tick, even without a layout change', () => {
    vi.useFakeTimers()
    const app = createStore<AppStore>()(appStoreCreator)
    let shell: 'powershell' | 'cmd' = 'powershell'
    let list: SavedWorkspace[] = [], writes = 0
    const sync = startSavedWorkspaceSync({ app, shell: () => shell, save: entries => { list = entries; writes++ } })
    app.getState().createWorkspace({ cwd: 'C:/project', terminalCount: 1, agentIds: ['terminal'] })
    vi.advanceTimersByTime(500)
    const before = writes
    app.getState().openWelcome()
    vi.advanceTimersByTime(500)
    expect(writes).toBe(before)
    shell = 'cmd'
    app.getState().closeWelcome()
    vi.advanceTimersByTime(500)
    expect(writes).toBe(before + 1)
    expect(list[0].layout.type === 'leaf' && list[0].layout.shellId).toBe('cmd')
    sync.dispose()
  })
  it('focus updates cannot postpone a pending meaningful save', () => {
    const t = setup()
    t.app.getState().createWorkspace({ cwd: 'C:/project', terminalCount: 2, agentIds: ['terminal', 'terminal'] })
    const ws = t.app.getState().workspaces[0]
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(100); t.app.getState().setFocusedLeaf(collectLeaves(ws.layout)[i % 2].id) }
    vi.advanceTimersByTime(100)
    expect(t.writes()).toBe(1)
    t.sync.dispose()
  })
  it('flushes the remaining layout when a pane closes before debounce', () => {
    const t = setup()
    t.app.getState().createWorkspace({ cwd: 'C:/project', terminalCount: 2, agentIds: ['terminal', 'terminal'] })
    const ws = t.app.getState().workspaces[0]
    t.app.getState().closePane(collectLeaves(ws.layout)[0].id)
    expect(t.writes()).toBe(1)
    expect(t.list()[0].layout.type).toBe('leaf')
    t.sync.dispose()
  })
  it('debounces meaningful changes and ignores focus/broadcast changes', () => {
    const t = setup()
    t.app.getState().createWorkspace({ cwd: 'C:/project', terminalCount: 2, agentIds: ['codex', 'terminal'] })
    const ws = t.app.getState().workspaces[0]
    t.app.getState().renameWorkspace(ws.id, 'New name')
    expect(t.writes()).toBe(0)
    vi.advanceTimersByTime(500)
    expect(t.list()[0].name).toBe('New name')
    t.app.getState().toggleBroadcast()
    t.app.getState().openWelcome()
    t.app.getState().setActiveWorkspace(ws.id)
    vi.advanceTimersByTime(500)
    expect(t.writes()).toBe(1)
    t.sync.dispose()
  })
  it('captures a workspace closed before the debounce fires', () => {
    const t = setup()
    t.app.getState().createWorkspace({ cwd: 'C:/project', terminalCount: 1, agentIds: ['terminal'] })
    t.app.getState().closeWorkspace(t.app.getState().workspaces[0].id)
    expect(t.list()).toHaveLength(1)
    expect(t.writes()).toBe(1)
    t.sync.dispose()
  })
  it('does not re-save a forgotten live workspace', () => {
    const t = setup()
    t.app.getState().createWorkspace({ cwd: 'C:/project', terminalCount: 1, agentIds: ['terminal'] })
    const ws = t.app.getState().workspaces[0]
    t.app.getState().forgetWorkspace(ws.savedId!)
    t.app.getState().renameWorkspace(ws.id, 'Still running')
    t.app.getState().closeWorkspace(ws.id)
    vi.advanceTimersByTime(500)
    expect(t.writes()).toBe(0)
    t.sync.dispose()
  })
  it('flushes pending snapshots and captures existing workspaces on startup', () => {
    const t = setup()
    t.app.getState().createWorkspace({ cwd: 'C:/project', terminalCount: 1, agentIds: ['terminal'] })
    t.sync.flush()
    expect(t.list()[0]).toEqual(toSaved(t.app.getState().workspaces[0], 'powershell', Date.now()))
    t.sync.dispose()
  })
})

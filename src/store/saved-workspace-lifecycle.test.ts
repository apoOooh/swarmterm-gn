import { describe, it, expect } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { appStoreCreator, type AppStore } from './app-store'
import { collectLeaves } from '@/lib/layout-tree'
import { toSaved } from '@/lib/saved-workspaces'

const id = '11111111-2222-4333-8444-555555555555'
describe('saved workspace runtime lifecycle', () => {
  it('records exact per-pane identities in inactive workspaces without changing spawn commands', () => {
    const store = createStore<AppStore>()(appStoreCreator)
    store.getState().createWorkspace({ cwd: '/project', terminalCount: 2, agentIds: ['claude-code', 'codex'] })
    const first = store.getState().workspaces[0]
    const [claude, codex] = collectLeaves(first.layout)
    store.getState().createWorkspace({ cwd: '/project', terminalCount: 1, agentIds: ['terminal'] })
    store.getState().recordPaneSession(codex.terminalId, 'codex', id)
    store.getState().recordPaneSession(claude.terminalId, 'claude-code', id.replace('11111111', '22222222'))
    const updated = collectLeaves(store.getState().workspaces[0].layout)
    expect(updated[1].sessionId).toBe(id)
    expect(updated[0].sessionId).not.toBe(id)
    expect(updated.map(l => l.resumeSessionId)).toEqual([undefined, undefined])
    const snapshot = store.getState()
    store.getState().recordPaneSession(codex.terminalId, 'claude-code', id)
    store.getState().recordPaneSession(codex.terminalId, 'codex', 'invalid; command')
    store.getState().recordPaneSession('closed', 'codex', id)
    store.getState().recordPaneSession(codex.terminalId, 'codex', id)
    expect(store.getState()).toBe(snapshot)
  })
  it('focuses an already-open saved workspace and creates fresh identities after close', () => {
    const store = createStore<AppStore>()(appStoreCreator)
    store.getState().createWorkspace({ cwd: '/project', terminalCount: 1, agentIds: ['codex'] })
    const old = store.getState().workspaces[0]
    const saved = toSaved(old, 'default', 0)!
    store.getState().openWelcome()
    store.getState().restoreWorkspace(saved)
    expect(store.getState().workspaces).toHaveLength(1)
    expect(store.getState().welcomeFocused).toBe(false)
    store.getState().closeWorkspace(old.id)
    store.getState().restoreWorkspace(saved)
    const next = store.getState().workspaces[0]
    expect(next.savedId).toBe(old.savedId)
    expect(next.id).not.toBe(old.id)
    expect(collectLeaves(next.layout)[0].terminalId).not.toBe(collectLeaves(old.layout)[0].terminalId)
  })
  it('drops identity when changing agent or directory; mode changes resume the observed conversation', () => {
    const store = createStore<AppStore>()(appStoreCreator)
    store.getState().createWorkspace({ cwd: '/project', terminalCount: 1, agentIds: ['codex'] })
    const leaf = () => collectLeaves(store.getState().workspaces[0].layout)[0]
    store.getState().recordPaneSession(leaf().terminalId, 'codex', id)
    store.getState().setPaneLaunchMode(leaf().id, 'default')
    expect(leaf().resumeSessionId).toBe(id)
    store.getState().setPaneCwd(leaf().id, '/other')
    expect(leaf().sessionId).toBeUndefined()
    expect(leaf().resumeSessionId).toBeUndefined()
    store.getState().recordPaneSession(leaf().terminalId, 'codex', id)
    store.getState().setPaneAgent(leaf().id, 'terminal')
    expect(leaf().sessionId).toBeUndefined()
  })
})

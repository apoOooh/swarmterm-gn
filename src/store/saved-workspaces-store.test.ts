import { beforeEach, describe, expect, it } from 'vitest'
import { autoOpenList, type SavedWorkspace } from '@/lib/saved-workspaces'
import { resetSeenWorkspaceIds, useSavedWorkspacesStore } from './saved-workspaces-store'

const entry = (id: string, updatedAt: number): SavedWorkspace => ({
  id, name: id, cwd: '/p', worktreeMode: false, updatedAt,
  layout: { type: 'leaf', id: `leaf-${id}`, agentId: 'terminal', shellId: 'default', cwd: '/p' } as SavedWorkspace['layout']
})

describe('save() with the pin-new setting', () => {
  beforeEach(() => { resetSeenWorkspaceIds(); useSavedWorkspacesStore.setState({ entries: [], writable: true, pinNew: false }) })

  it('leaves new workspaces unpinned while the setting is off', () => {
    useSavedWorkspacesStore.getState().save([entry('a', 1)])
    expect(autoOpenList(useSavedWorkspacesStore.getState().entries)).toHaveLength(0)
  })

  it('pins a new workspace once and keeps a later unpin across snapshots', () => {
    useSavedWorkspacesStore.setState({ pinNew: true })
    const { save, setAutoOpen } = useSavedWorkspacesStore.getState()
    save([entry('pin-once', 1)])
    expect(autoOpenList(useSavedWorkspacesStore.getState().entries).map(w => w.id)).toEqual(['pin-once'])
    setAutoOpen('pin-once', false)
    save([entry('pin-once', 2)])
    expect(autoOpenList(useSavedWorkspacesStore.getState().entries)).toHaveLength(0)
  })
})

import type { StoreApi } from 'zustand/vanilla'
import type { AppStore } from '@/store/app-store'
import type { ShellId } from '@/lib/terminal-pref'
import { toSaved, type SavedWorkspace } from './saved-workspaces'
import { savedLeaves } from './saved-workspace-restore'

interface SyncDependencies { app: StoreApi<AppStore>; shell: () => ShellId; save: (entries: SavedWorkspace[]) => void }

/** Keep snapshots pending by saved id, so closing one workspace cannot drop another's save. */
export function startSavedWorkspaceSync({ app, shell, save }: SyncDependencies) {
  const pending = new Map<string, SavedWorkspace>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer); timer = undefined
    if (!pending.size) return
    const entries = [...pending.values()]
    pending.clear()
    save(entries)
  }
  const snapshot = () => new Map(app.getState().workspaces.flatMap(ws => {
    const saved = toSaved(ws, shell(), 0)
    return saved ? [[saved.id, saved] as const] : []
  }))
  let previous = new Map<string, SavedWorkspace>()
  const update = () => {
    let changed = false
    let closedPane = false
    const current = snapshot()
    // Forget clears savedId while the workspace is still live; closing removes
    // the entire instance. Only the latter must persist its final snapshot.
    const live = new Set(app.getState().workspaces.map(w => w.id))
    for (const [id, old] of previous) {
      if (current.has(id)) continue
      const owner = owners.get(id)
      if (owner && live.has(owner)) pending.delete(id)
      else { pending.set(id, pending.get(id) ?? { ...old, updatedAt: Date.now() }); flush() }
    }
    for (const [id, next] of current) {
      if (JSON.stringify(next) !== JSON.stringify(previous.get(id))) {
        const old = previous.get(id)
        closedPane ||= !!old && savedLeaves(next.layout).length < savedLeaves(old.layout).length
        pending.set(id, { ...next, updatedAt: Date.now() }); changed = true
      }
    }
    previous = current
    owners = new Map(app.getState().workspaces.flatMap(w => w.savedId ? [[w.savedId, w.id] as const] : []))
    if (closedPane) flush()
    else if (changed && pending.size) { clearTimeout(timer); timer = setTimeout(flush, 500) }
  }
  let owners = new Map<string, string>()
  update()
  const unsubscribe = app.subscribe(update)
  return { flush, refresh: update, dispose: () => { unsubscribe(); flush() } }
}

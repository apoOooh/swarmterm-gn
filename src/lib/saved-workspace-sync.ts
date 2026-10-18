import type { StoreApi } from 'zustand/vanilla'
import type { AppStore } from '@/store/app-store'
import type { ShellId } from '@/lib/terminal-pref'
import { toSaved, type SavedWorkspace } from './saved-workspaces'
import { savedLeaves } from './saved-workspace-restore'

interface SyncDependencies {
  app: StoreApi<AppStore>; shell: () => ShellId; save: (entries: SavedWorkspace[]) => void
  /** Whether snapshots keep pane ids (`toSaved`); a change needs `refresh`. */
  paneIds?: () => boolean
}

/** Keep snapshots pending by saved id, so closing one workspace cannot drop another's save. */
export function startSavedWorkspaceSync({ app, shell, save, paneIds = () => false }: SyncDependencies) {
  const pending = new Map<string, SavedWorkspace>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer); timer = undefined
    if (!pending.size) return
    const entries = [...pending.values()]
    pending.clear()
    save(entries)
  }
  // Workspaces are immutable store objects: an unchanged object with the same
  // shell yields the same snapshot, so its toSaved + JSON are reused instead of
  // re-walking and re-serializing every layout on every store tick.
  const cache = new WeakMap<object, { shell: ShellId; ids: boolean; saved: SavedWorkspace | undefined; json: string }>()
  const json = new WeakMap<SavedWorkspace, string>()
  const snapshot = () => {
    const sh = shell(), ids = paneIds()
    return new Map(app.getState().workspaces.flatMap(ws => {
      let hit = cache.get(ws)
      if (!hit || hit.shell !== sh || hit.ids !== ids) {
        const saved = toSaved(ws, sh, 0, ids)
        hit = { shell: sh, ids, saved, json: saved ? JSON.stringify(saved) : '' }
        cache.set(ws, hit)
        if (saved) json.set(saved, hit.json)
      }
      return hit.saved ? [[hit.saved.id, hit.saved] as const] : []
    }))
  }
  const serialized = (saved: SavedWorkspace | undefined) => saved === undefined ? undefined : json.get(saved) ?? JSON.stringify(saved)
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
      const old = previous.get(id)
      if (next !== old && serialized(next) !== serialized(old)) {
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
  // Only a new workspaces array (or shell) can change a snapshot; focus, drop
  // target and other ticks are skipped. `refresh` stays a full rebuild.
  let lastShell = shell()
  const unsubscribe = app.subscribe((state, prev) => {
    const sh = shell()
    if (state.workspaces === prev.workspaces && sh === lastShell) return
    lastShell = sh
    update()
  })
  return { flush, refresh: update, dispose: () => { unsubscribe(); flush() } }
}

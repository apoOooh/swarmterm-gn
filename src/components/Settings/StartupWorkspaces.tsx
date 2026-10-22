import type { ReactElement } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { autoOpenList } from '@/lib/saved-workspaces'
import { useSavedWorkspacesStore } from '@/store/saved-workspaces-store'

/** Saved workspaces that open on app start; while any is set, Welcome is skipped. */
export function StartupWorkspaces(): ReactElement {
  const entries = useSavedWorkspacesStore((s) => s.entries)
  const pinNew = useSavedWorkspacesStore((s) => s.pinNew)
  const { setAutoOpen, moveAutoOpen, setPinNew } = useSavedWorkspacesStore.getState()
  const startup = autoOpenList(entries)
  const others = entries.filter((w) => w.autoOpen === undefined)
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-foreground">Open on startup</h2>
      <p className="mb-3 max-w-prose text-xs text-muted-foreground">
        These saved workspaces open in the navbar when Swarmterm starts, agents resume their sessions.
        Welcome is skipped while at least one is selected.
      </p>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={pinNew} onChange={(e) => setPinNew(e.target.checked)} />
        Open new workspaces on startup by default
      </label>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No saved workspaces yet. Create a workspace first; it is saved automatically.</p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {[...startup, ...others].map((w) => {
            const on = w.autoOpen !== undefined
            return (
              <div key={w.id} className="flex items-center gap-3 px-3 py-2" data-startup-workspace-id={w.id}>
                <input type="checkbox" checked={on} aria-label={`Open ${w.name} on startup`} onChange={(e) => setAutoOpen(w.id, e.target.checked)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{w.name}</div>
                  <div title={w.cwd} className="truncate text-xs text-muted-foreground">{w.cwd}</div>
                </div>
                {on && <>
                  <button type="button" aria-label={`Move ${w.name} up`} disabled={w.autoOpen === 0} onClick={() => moveAutoOpen(w.id, -1)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={`Move ${w.name} down`} disabled={w.autoOpen === startup.length - 1} onClick={() => moveAutoOpen(w.id, 1)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                </>}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

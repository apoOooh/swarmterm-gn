import { useRef, useState, type ReactElement } from 'react'
import { Pencil, Pin, X } from 'lucide-react'
import type { SavedWorkspace } from '@/lib/saved-workspaces'
import { savedLeaves } from '@/lib/saved-workspace-restore'
import { sessionTimeLabel } from '@/lib/agent-sessions'
import { useSavedWorkspacesStore } from '@/store/saved-workspaces-store'
import { SavedLayoutPreview } from './LayoutPreview'

export function SavedWorkspaceCard({ workspace }: { workspace: SavedWorkspace }): ReactElement {
  const open = useSavedWorkspacesStore(s => s.open)
  const rename = useSavedWorkspacesStore(s => s.rename)
  const forget = useSavedWorkspacesStore(s => s.forget)
  const setAutoOpen = useSavedWorkspacesStore(s => s.setAutoOpen)
  const pinned = workspace.autoOpen !== undefined
  const busy = useSavedWorkspacesStore(s => s.opening.includes(workspace.id))
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(workspace.name)
  const cancelled = useRef(false)
  const leaves = savedLeaves(workspace.layout)
  const sessions = leaves.filter(l => l.sessionId).length
  const apply = () => { if (!cancelled.current) rename(workspace.id, name); cancelled.current = true; setEditing(false) }
  return <div data-saved-workspace-id={workspace.id} className="group flex min-w-0 items-center gap-2 rounded-lg border border-border p-2 hover:bg-accent/40">
    {editing ? <form className="min-w-0 flex-1" onSubmit={e => { e.preventDefault(); apply() }}>
      <input autoFocus aria-label={`Rename ${workspace.name}`} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setEditing(false) } }} onBlur={apply} className="w-full rounded border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring" />
    </form> : <button type="button" disabled={busy} aria-label={`Open saved workspace ${workspace.name}`} onClick={() => void open(workspace.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-60">
      <div className="h-12 w-16 shrink-0"><SavedLayoutPreview node={workspace.layout} /></div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{busy ? 'Opening…' : workspace.name}</div>
        <div title={workspace.cwd} className="truncate text-xs text-muted-foreground">{workspace.cwd}</div>
        <div className="text-xs text-muted-foreground">{leaves.length} {leaves.length === 1 ? 'pane' : 'panes'} · {sessions} {sessions === 1 ? 'session' : 'sessions'} · {sessionTimeLabel(workspace.updatedAt, Date.now())}</div>
      </div>
    </button>}
    <button type="button" aria-pressed={pinned} aria-label={`Open ${workspace.name} on startup`} title="Open on startup" onClick={() => setAutoOpen(workspace.id, !pinned)} className={`rounded p-1 hover:bg-accent hover:text-foreground ${pinned ? 'text-foreground' : 'text-muted-foreground'}`}><Pin className={`h-3.5 w-3.5 ${pinned ? 'fill-current' : ''}`} /></button>
    <button type="button" aria-label={`Rename saved workspace ${workspace.name}`} onClick={() => { cancelled.current = false; setName(workspace.name); setEditing(true) }} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
    <button type="button" aria-label={`Forget saved workspace ${workspace.name}`} onClick={() => forget(workspace.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
  </div>
}

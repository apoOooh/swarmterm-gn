import { X } from 'lucide-react'
import { useSavedWorkspacesStore } from '@/store/saved-workspaces-store'

export function SavedWorkspaceNotice(): React.ReactElement | null {
  const notice = useSavedWorkspacesStore(s => s.notice)
  const error = useSavedWorkspacesStore(s => s.error)
  const dismiss = useSavedWorkspacesStore(s => s.dismissNotice)
  if (!notice && !error) return null
  return <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-border bg-accent px-4 py-2 text-xs">
    <span className="flex-1">{[error, notice].filter(Boolean).join(' ')}</span>
    {notice && <button type="button" aria-label="Dismiss workspace notice" onClick={dismiss}><X className="h-4 w-4" /></button>}
  </div>
}

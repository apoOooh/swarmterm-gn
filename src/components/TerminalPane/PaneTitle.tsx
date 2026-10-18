import { useState, type ReactElement } from 'react'
import { MAX_PANE_NAME } from '@/lib/pane-address'
import { useAppStore } from '@/store/app-store'
import { cn } from '@/lib/utils'

interface PaneTitleProps {
  leafId: string
  title: string
  /** The user-given name, prefilled when editing. */
  name?: string
  /** 1-based pane number (BUZ-5 voice addressing); 0 = not on screen. */
  number: number
  tooltip?: string
  className?: string
}

/**
 * Pane number badge + title; double-click renames (BUZ-5). Shared by the pane
 * header and the navbar list so both edit the same `leaf.name`. The input is a
 * real <input>, so terminal-focus stands down while it is open and Enter/Escape
 * never reach the shell.
 */
export function PaneTitle({ leafId, title, name, number, tooltip, className }: PaneTitleProps): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    useAppStore.getState().renamePane(leafId, draft)
    setEditing(false)
  }
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      {number > 0 && (
        <span
          aria-label={`Pane ${number}`}
          title={`Pane ${number} — say "Pane ${number}: …" to dictate here`}
          className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4 tabular-nums text-muted-foreground"
        >
          {number}
        </span>
      )}
      {editing ? (
        <input
          autoFocus
          value={draft}
          maxLength={MAX_PANE_NAME}
          placeholder={title}
          aria-label="Pane name"
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commit}
          className="min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs text-foreground outline-none"
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate"
          title={tooltip ?? `${title} — double-click to rename`}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(name ?? '')
            setEditing(true)
          }}
        >
          {title}
        </span>
      )}
    </span>
  )
}

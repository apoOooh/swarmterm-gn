import { useRef, useState, type ReactElement } from 'react'
import { MAX_PANE_NAME } from '@/lib/pane-address'
import { useAppStore } from '@/store/app-store'
import { cn } from '@/lib/utils'
import { PaneIdentityIcon } from './PaneIdentityIcon'
import { SmilePlus } from 'lucide-react'

interface PaneTitleProps {
  leafId: string
  title: string
  /** The user-given name, prefilled when editing. */
  name?: string
  /** 1-based pane number (BUZ-5 voice addressing); 0 = not on screen. */
  number: number
  tooltip?: string
  className?: string
  /** Shown muted after the title — the automatic title when a name is set. */
  subtitle?: string
  /** Identity icon + color (lib/pane-identity). */
  icon?: string
  color?: string
  /** Opens the identity dialog from the icon slot; without it the slot only shows a set icon. */
  onEditIdentity?: () => void
}

/**
 * Pane number badge + title; double-click renames (BUZ-5). Shared by the pane
 * header and the navbar list so both edit the same `leaf.name`. The input is a
 * real <input>, so terminal-focus stands down while it is open and Enter/Escape
 * never reach the shell.
 */
export function PaneTitle({ leafId, title, name, number, tooltip, className, subtitle, icon, color, onEditIdentity }: PaneTitleProps): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Escape unmounts the input, which fires onBlur: without this flag the
  // discarded draft would be saved on the way out.
  const discarded = useRef(false)
  const commit = (): void => {
    if (!discarded.current) useAppStore.getState().renamePane(leafId, draft)
    setEditing(false)
  }
  return (
    <span className={cn('group/pane-title flex min-w-0 items-center gap-1', className)}>
      {number > 0 && (
        <span
          aria-label={`Pane ${number}`}
          title={`Pane ${number} — say "Pane ${number}: …" to dictate here`}
          className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4 tabular-nums text-muted-foreground"
        >
          {number}
        </span>
      )}
      {onEditIdentity ? (
        <button
          type="button"
          data-no-dnd
          aria-label={icon ? 'Change pane identity' : 'Set pane identity'}
          title={icon ? 'Change icon, name and color' : 'Give this pane an icon and name'}
          onClick={(e) => { e.stopPropagation(); onEditIdentity() }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-accent',
            // An empty slot only appears on hover, so unnamed panes look as before.
            !icon && 'text-muted-foreground opacity-0 group-hover/pane-title:opacity-60 focus-visible:opacity-100'
          )}
        >
          {icon ? <PaneIdentityIcon icon={icon} color={color} /> : <SmilePlus aria-hidden className="h-3 w-3" />}
        </button>
      ) : icon ? (
        <PaneIdentityIcon icon={icon} color={color} />
      ) : null}
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
            else if (e.key === 'Escape') {
              discarded.current = true
              setEditing(false)
            }
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
            discarded.current = false
            setEditing(true)
          }}
        >
          {subtitle ? (
            <>
              <span className="font-semibold">{title}</span>
              <span className="text-muted-foreground"> · {subtitle}</span>
            </>
          ) : title}
        </span>
      )}
    </span>
  )
}

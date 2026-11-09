import { type ReactElement } from 'react'
import { useAppStore } from '@/store/app-store'
import { locatePane, paneLocationLabel } from '@/lib/pane-location'
import { MODERATOR_ID } from '@/tauri/warroom'
import { cn } from '@/lib/utils'

/**
 * Live "Pane 2 · Backend" for a terminal (SWA-90), or null once its pane is
 * closed. The selector returns a string, so a member row only re-renders when
 * its own label changes, not on every layout edit.
 */
export function usePaneLabel(terminalId: string): string | null {
  return useAppStore((s) => {
    if (terminalId === MODERATOR_ID) return null
    const loc = locatePane(s.workspaces, terminalId)
    return loc ? paneLocationLabel(loc, s.workspaces.length > 1) : null
  })
}

/**
 * The pane number badge as the pane header shows it, so a War Room member
 * reads like the pane it is — several members with the same title stay
 * distinguishable (which one may be closed or moved).
 */
export function PaneTag({ terminalId, className }: { terminalId: string; className?: string }): ReactElement | null {
  const label = usePaneLabel(terminalId)
  if (!label) return null
  return (
    <span
      title={label}
      className={cn(
        'shrink-0 truncate rounded bg-muted px-1 text-[10px] font-normal leading-4 tabular-nums text-muted-foreground',
        className
      )}
    >
      {label}
    </span>
  )
}

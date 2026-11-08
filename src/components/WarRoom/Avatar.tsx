// The one expressive element is the member identity color (avatar ring →
// name → header), derived from terminalId so it survives renames and
// re-joins; everything else stays in the app's VS Code palette.
import { type ReactElement } from 'react'
import { Crown } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/app-store'
import { focusTerminal } from '@/lib/terminal-registry'
import { templateById, DEFAULT_TEMPLATE_ID } from '@/lib/templates'
import { memberColor } from '@/lib/war-room-identity'
import { AgentIcon } from '@/components/AgentIcon'
import { PaneIdentityIcon } from '@/components/TerminalPane/PaneIdentityIcon'
import { collectLeaves } from '@/lib/layout-tree'
import { MODERATOR_ID } from '@/tauri/warroom'
import { cn } from '@/lib/utils'

/** Jump to the member's pane: activate its workspace, focus its terminal. */
export function jumpToTerminal(terminalId: string): void {
  // The Moderator seat is the user, not a pane — there is nothing to reveal.
  if (terminalId === MODERATOR_ID) return
  useAppStore.getState().revealTerminal(terminalId)
  focusTerminal(terminalId)
}

export function Avatar({
  terminalId,
  agentId,
  size = 'md',
  onClick
}: {
  terminalId: string
  agentId: string | null
  size?: 'sm' | 'md'
  onClick?: () => void
}): ReactElement {
  const isModerator = terminalId === MODERATOR_ID
  const template = templateById(agentId ?? DEFAULT_TEMPLATE_ID)
  // A pane identity (icon + color) the user set wins, read live from the
  // layout so a later change shows here without re-joining the room.
  const { identityIcon, identityColor } = useAppStore(useShallow((s) => {
    for (const w of s.workspaces) {
      const leaf = collectLeaves(w.layout).find((l) => l.terminalId === terminalId)
      if (leaf) return { identityIcon: leaf.icon, identityColor: leaf.icon ? leaf.color : undefined }
    }
    return { identityIcon: undefined, identityColor: undefined }
  }))
  const color = identityColor || memberColor(terminalId)
  return (
    <button
      data-no-dnd
      tabIndex={-1}
      onClick={isModerator ? undefined : onClick}
      title={isModerator ? 'You (Moderator)' : 'Go to this terminal'}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full',
        size === 'md' ? 'h-6 w-6' : 'h-4 w-4',
        onClick && !isModerator && 'cursor-pointer'
      )}
      style={{ backgroundColor: `${color}26`, boxShadow: `inset 0 0 0 1px ${color}` }}
    >
      {isModerator ? (
        <Crown className={size === 'md' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5'} style={{ color }} />
      ) : identityIcon ? (
        <PaneIdentityIcon icon={identityIcon} color={color} className={size === 'md' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5 text-[8px]'}
          fallback={<AgentIcon template={template} className={size === 'md' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5'} />} />
      ) : (
        <AgentIcon template={template} className={size === 'md' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5'} />
      )}
    </button>
  )
}

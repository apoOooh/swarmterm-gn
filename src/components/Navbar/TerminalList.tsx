import type { ReactElement } from 'react'
import { Archive, ArchiveRestore, EyeOff, Maximize2 } from 'lucide-react'
import type { LeafNode } from '@/lib/layout-tree'
import { collectLeaves } from '@/lib/layout-tree'
import { templateById, DEFAULT_TEMPLATE_ID } from '@/lib/templates'
import { resolvePaneTitle } from '@/lib/pane-title'
import { useAppStore, isDrawered } from '@/store/app-store'
import { useDocumentStore } from '@/store/document-store'
import { useExplorerStore } from '@/store/explorer-store'
import { useTerminalTitleStore } from '@/store/terminal-title-store'
import { useTerminalActivityStore } from '@/store/terminal-activity-store'
import { useAgentStateStore } from '@/store/agent-state-store'
import { displayState, paneDot } from '@/lib/agent-state/rollup'
import { AgentIcon } from '@/components/AgentIcon'
import { ActivityDot } from '@/components/ActivityDot'
import { StateDot } from '@/components/StateDot'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { accountLabel } from '@/lib/agent-accounts'
import { cn } from '@/lib/utils'

/**
 * The TERMINALS section of the left rail: one row per pane of the *active*
 * workspace, by agent icon + title. Clicking a row focuses that pane — it reuses
 * `setFocusedLeaf`, which both highlights the pane and (via TerminalPane's
 * `isFocused` effect) pulls keyboard focus into its xterm. Hidden on the Welcome
 * screen, since it mirrors the foreground workspace and there is none there.
 *
 * Drawered panes sit in their own "Drawer" subgroup below the open ones. One
 * click restores — the same gesture as on an open row ("take me to this
 * terminal"), which for a parked pane means bring it back first. Their state
 * dot stays live, so an agent finishing in the drawer still flags itself.
 */
export function TerminalList(): ReactElement | null {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const welcomeFocused = useAppStore((s) => s.welcomeFocused)
  const setFocusedLeaf = useAppStore((s) => s.setFocusedLeaf)
  const accounts = useAgentAccountsStore(s => s.accounts)
  const titles = useTerminalTitleStore((s) => s.titles)
  const activity = useTerminalActivityStore((s) => s.active)
  const agentStates = useAgentStateStore((s) => s.byId)

  const active = workspaces.find((w) => w.id === activeWorkspaceId)
  // Nothing to mirror while the Welcome tab is foreground or before any
  // workspace exists.
  if (welcomeFocused || !active) return null

  const leaves = collectLeaves(active.layout)
  // Drawer order (oldest parked first), not layout order — it is a stack of
  // things set aside, and the newest one belongs at the bottom.
  const openLeaves = leaves.filter((l) => !isDrawered(active, l.id))
  // Mirrors Workspace: a zoom only takes effect on a docked, non-drawered pane.
  const zoomActive = openLeaves.some((l) => l.id === active.zoomedLeafId)
    && !(active.floating ?? []).some((r) => r.leafId === active.zoomedLeafId)
  const drawered = (active.drawerLeafIds ?? [])
    .map((id) => leaves.find((l) => l.id === id))
    .filter((l): l is LeafNode => l !== undefined)

  function renderRow(leaf: LeafNode, inDrawer: boolean): ReactElement {
    const agentId = leaf.agentId ?? DEFAULT_TEMPLATE_ID
    const template = templateById(agentId)
    const title = resolvePaneTitle(agentId, titles[leaf.terminalId])
    const focused = !inDrawer && leaf.id === active!.focusedLeafId
    const zoomed = zoomActive && !inDrawer && leaf.id === active!.zoomedLeafId
    // Open but covered by another pane's zoom; it keeps running off-screen.
    const behindZoom = !inDrawer && !zoomed && zoomActive
    const dot = paneDot(displayState(agentStates[leaf.terminalId]), activity[leaf.terminalId] === true)
    return (
      <li key={leaf.id}>
        <div
          onClick={() => {
            useDocumentStore.getState().select(leaf.id, null)
            useExplorerStore.setState({ visible: true })
            // setFocusedLeaf also pulls a drawered pane back into its slot.
            setFocusedLeaf(leaf.id)
          }}
          title={inDrawer
            ? `${title} — in drawer, click to restore`
            : zoomed
              ? `${title} — maximized`
              : behindZoom ? `${title} — hidden behind the maximized pane, click to show` : title}
          className={cn(
            'theme-row group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm',
            focused
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            inDrawer && 'italic opacity-70 hover:opacity-100',
            zoomed && 'border-l-2 border-zoom pl-1.5'
          )}
        >
          {/* Dim only icon + title of a covered pane: its state dot stays at full
              strength so an agent needing input behind the zoom still shows. */}
          <AgentIcon template={template} className={cn('h-3.5 w-3.5 shrink-0', behindZoom && 'opacity-50')} />
          <span className={cn('flex-1 truncate', behindZoom && 'opacity-50')}>{title}</span>
          {zoomed && <Maximize2 aria-label="Maximized" className="h-3 w-3 shrink-0 text-zoom" />}
          {behindZoom && <EyeOff aria-label="Hidden behind maximized pane" className="h-3 w-3 shrink-0 opacity-60" />}
          {(agentId === 'claude-code' || agentId === 'codex') && <span className="max-w-20 truncate text-[10px]" title={`Account: ${accountLabel(leaf.accountId, accounts)}`}>{accountLabel(leaf.accountId, accounts)}</span>}
          {dot !== null && (dot === 'activity'
            ? <ActivityDot />
            : <StateDot state={dot} sinceMs={agentStates[leaf.terminalId]?.sinceMs} />)}
          {/* Hover affordance; the row click does the same for drawered rows,
              so this mainly signals what a click will do. */}
          <button
            type="button"
            tabIndex={-1}
            aria-label={inDrawer ? 'Restore from drawer' : 'Move to drawer'}
            title={inDrawer ? 'Restore from drawer' : 'Move to drawer'}
            onClick={(e) => {
              e.stopPropagation()
              const st = useAppStore.getState()
              if (inDrawer) st.restorePane(leaf.id)
              else st.drawerPane(leaf.id)
            }}
            className="hidden shrink-0 rounded p-0.5 hover:bg-accent group-hover:block"
          >
            {inDrawer
              ? <ArchiveRestore className="h-3.5 w-3.5" />
              : <Archive className="h-3.5 w-3.5" />}
          </button>
        </div>
      </li>
    )
  }

  // Its own bounded pane that splits the rail's non-footer height with the
  // Workspaces pane above (`flex-1 + min-h-0`). A FIXED header (never scrolls,
  // so rows can't bleed up over it) sits above a separate `overflow-y-auto`
  // body, so the terminal list scrolls *inside* this region rather than pushing
  // the list or the footer off-screen.
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <p className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
        Terminals
        {zoomActive && (
          <span className="ml-2 rounded bg-zoom/15 px-1 py-px text-[10px] normal-case tracking-normal text-zoom">
            Maximized
          </span>
        )}
      </p>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {openLeaves.map((leaf) => renderRow(leaf, false))}
        {drawered.length > 0 && (
          <li
            aria-hidden="true"
            className="mt-2 flex items-center gap-1.5 border-t border-border px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            <Archive className="h-3 w-3" />
            Drawer ({drawered.length})
          </li>
        )}
        {drawered.map((leaf) => renderRow(leaf, true))}
      </ul>
    </div>
  )
}

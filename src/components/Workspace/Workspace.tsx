import type { ReactElement } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { LayoutNode, LeafNode } from '@/lib/layout-tree'
import { useAppStore, type Workspace as WorkspaceModel } from '@/store/app-store'
import { PaneWorkbench } from '@/components/Files/PaneWorkbench'
import { BroadcastBanner } from '@/components/Workspace/BroadcastBanner'
import { SnapBar } from '@/components/Workspace/SnapBar'
import { AgentIcon } from '@/components/AgentIcon'
import { templateById, DEFAULT_TEMPLATE_ID } from '@/lib/templates'
import { cn } from '@/lib/utils'
import { zoomedLeaf } from '@/lib/pane-zoom'
import { visibleLayout } from '@/lib/pane-drawer'
import { Archive } from 'lucide-react'

interface WorkspaceProps {
  workspace: WorkspaceModel
}

/** Render one workspace: its binary split-tree of resizable terminal panes. */
export function Workspace({ workspace }: WorkspaceProps): ReactElement {
  const resizeSplitNode = useAppStore((s) => s.resizeSplitNode)

  function renderNode(node: LayoutNode): ReactElement {
    if (node.type === 'leaf') {
      return (
        <PaneWorkbench
          key={node.id}
          leaf={node}
          cwd={workspace.cwd}
          isFocused={node.id === workspace.focusedLeafId}
          broadcastActive={workspace.broadcastActive}
          isBroadcastMember={
            workspace.broadcastActive && workspace.broadcastLeafIds.includes(node.id)
          }
          worktreeMode={workspace.worktreeMode}
          isZoomed={workspace.zoomedLeafId === node.id}
        />
      )
    }

    const leftId = `${node.id}:a`
    const rightId = `${node.id}:b`
    return (
      <Group
        key={node.id}
        orientation={node.direction}
        className="h-full w-full"
        defaultLayout={{ [leftId]: node.sizes[0], [rightId]: node.sizes[1] }}
        onLayoutChanged={(layout) => {
          const a = layout[leftId]
          const b = layout[rightId]
          if (typeof a === 'number' && typeof b === 'number') {
            resizeSplitNode(node.id, [a, b])
          }
        }}
      >
        <Panel id={leftId} minSize="8%" className="h-full w-full overflow-hidden">
          {renderNode(node.children[0])}
        </Panel>
        <Separator
          className={cn(
            'shrink-0 bg-canvas transition-colors hover:bg-ring data-[separator]:bg-canvas',
            node.direction === 'horizontal' ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'
          )}
        />
        <Panel id={rightId} minSize="8%" className="h-full w-full overflow-hidden">
          {renderNode(node.children[1])}
        </Panel>
      </Group>
    )
  }

  // data-focus-return: dragging a split separator (or clicking the gap
  // between panes) leaves DOM focus on chrome; App.tsx hands the keyboard
  // back to the focused terminal — see lib/terminal-focus.ts.
  // Drawered panes are pruned first, then zoom picks from what is left. Both
  // only unmount the hidden panes: their xterm + pty live on in
  // terminal-registry and reattach on restore/unzoom.
  const visible = visibleLayout(workspace.layout, workspace.drawerLeafIds ?? [])
  const drawerCount = workspace.drawerLeafIds?.length ?? 0
  return (
    <div data-focus-return className="flex h-full w-full flex-col bg-canvas">
      <BroadcastBanner workspace={workspace} />
      <div className="relative min-h-0 flex-1 p-2">
        {visible
          ? renderNode(zoomedLeaf(visible, workspace.zoomedLeafId) ?? visible)
          : <EmptyDrawerState count={drawerCount} />}
        <SnapBar layout={workspace.layout} drawerLeafIds={workspace.drawerLeafIds ?? []} />
      </div>
    </div>
  )
}

/** Shown when every pane of the workspace sits in the drawer. */
function EmptyDrawerState({ count }: { count: number }): ReactElement {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-sm text-muted-foreground">
      <Archive className="h-6 w-6" aria-hidden="true" />
      <p>
        {count === 1 ? 'The terminal is' : `All ${count} terminals are`} in the drawer.
      </p>
      <p className="text-xs">Click one under Drawer in the sidebar to restore it.</p>
    </div>
  )
}

/**
 * The lifted "ghost" shown under the cursor while a pane is dragged. Kept a
 * small card pinned to the grab corner rather than the pane's full size: a
 * full-size ghost would blanket the dock picker and snap bar the user is
 * aiming at. The body is a static placeholder — a live xterm instance can't be
 * cloned into the overlay.
 */
export function PaneDragGhost({ leaf }: { leaf: LeafNode }): ReactElement {
  const agent = templateById(leaf.agentId ?? DEFAULT_TEMPLATE_ID)
  return (
    <div className="pointer-events-none flex h-20 w-52 cursor-grabbing flex-col overflow-hidden rounded-md border border-ring bg-background opacity-80 shadow-2xl">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 text-sm text-foreground">
        <AgentIcon template={agent} className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{agent.name}</span>
      </div>
      <div className="flex-1 bg-background" />
    </div>
  )
}

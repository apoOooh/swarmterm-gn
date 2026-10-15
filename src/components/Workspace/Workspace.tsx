import { memo, useEffect, useRef, type ReactElement } from 'react'
import { Group, Panel, Separator, type GroupImperativeHandle } from 'react-resizable-panels'
import type { LayoutNode, LeafNode } from '@/lib/layout-tree'
import { useAppStore, type Workspace as WorkspaceModel } from '@/store/app-store'
import { PaneWorkbench } from '@/components/Files/PaneWorkbench'
import { BroadcastBanner } from '@/components/Workspace/BroadcastBanner'
import { SnapBar } from '@/components/Workspace/SnapBar'
import { CornerHandles } from '@/components/Workspace/CornerHandles'
import { FloatingPane } from '@/components/Workspace/FloatingPane'
import { hiddenLeafIds } from '@/lib/floating-panes'
import { findLeaf } from '@/lib/layout-tree'
import { AgentIcon } from '@/components/AgentIcon'
import { templateById, DEFAULT_TEMPLATE_ID } from '@/lib/templates'
import { cn } from '@/lib/utils'
import { zoomedLeaf, zoomHiddenCount } from '@/lib/pane-zoom'
import { visibleLayout } from '@/lib/pane-drawer'
import { splitsToRealign } from '@/lib/split-sync'
import { Archive } from 'lucide-react'

interface WorkspaceProps {
  workspace: WorkspaceModel
}

/** Render one workspace: its binary split-tree of resizable terminal panes.
 * Memoized: workspace objects are immutable store values, so App re-rendering
 * for a change in ONE workspace no longer re-renders every (hidden) other. */
export const Workspace = memo(function Workspace({ workspace }: WorkspaceProps): ReactElement {
  const resizeSplitNode = useAppStore((s) => s.resizeSplitNode)
  const equalizeSplitNode = useAppStore((s) => s.equalizeSplitNode)
  // Live Group handles so CornerHandles can move two splits in one drag.
  const groups = useRef(new Map<string, GroupImperativeHandle>())

  // Groups are uncontrolled: `sizes` only seeds a Group when it mounts. Tidy
  // rewrites the sizes of splits that stay mounted, so push the stored sizes
  // into any live Group that disagrees. Drags and corner drags commit what the
  // Group already shows, so they never trigger a write here. getLayout() is
  // empty until a Group is measured; those Groups are skipped (they seed from
  // the store on mount anyway). A hidden workspace's Groups keep their last
  // measured size, so a Tidy there lands too. The handle throws for a Group
  // that is already gone; a missed realign is only cosmetic, so fail open
  // rather than take the tree down from an effect.
  useEffect(() => {
    const live = (id: string): [number, number] | undefined => {
      try {
        const layout = groups.current.get(id)?.getLayout()
        const a = layout?.[`${id}:a`]
        const b = layout?.[`${id}:b`]
        return typeof a === 'number' && typeof b === 'number' ? [a, b] : undefined
      } catch {
        return undefined
      }
    }
    for (const { id, sizes } of splitsToRealign(workspace.layout, live)) {
      try {
        groups.current.get(id)?.setLayout({ [`${id}:a`]: sizes[0], [`${id}:b`]: sizes[1] })
      } catch {
        /* Group unmounted since the read above */
      }
    }
  }, [workspace.layout])

  function renderLeaf(node: LeafNode, isFloating = false): ReactElement {
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
          zoomHiddenCount={workspace.zoomedLeafId === node.id
            ? zoomHiddenCount(workspace.layout, node.id, workspace.drawerLeafIds ?? [])
            : 0}
          isFloating={isFloating}
        />
    )
  }

  function renderNode(node: LayoutNode): ReactElement {
    if (node.type === 'leaf') return renderLeaf(node)

    const leftId = `${node.id}:a`
    const rightId = `${node.id}:b`
    return (
      <Group
        key={node.id}
        orientation={node.direction}
        groupRef={(handle) => {
          if (handle) groups.current.set(node.id, handle)
          else groups.current.delete(node.id)
        }}
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
          title="Double-click to even out"
          // Our own reset replaces the library one (which only targets a
          // Panel defaultSize, and we have none).
          disableDoubleClick
          onDoubleClick={() => equalizeSplitNode(node.id)}
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
  // Floating panes are pruned like drawered ones and drawn on top instead.
  const floating = workspace.floating ?? []
  const visible = visibleLayout(workspace.layout, hiddenLeafIds(workspace.drawerLeafIds ?? [], floating))
  const drawerCount = workspace.drawerLeafIds?.length ?? 0
  const zoomed = visible ? zoomedLeaf(visible, workspace.zoomedLeafId) : null
  return (
    <div data-focus-return className="flex h-full w-full flex-col bg-canvas">
      <BroadcastBanner workspace={workspace} />
      <div className="relative min-h-0 flex-1 p-2">
        {visible
          ? renderNode(zoomed ?? visible)
          : drawerCount > 0 && <EmptyDrawerState count={drawerCount} />}
        {visible && !zoomed && <CornerHandles layout={visible} groups={groups} inset={8} />}
        {!zoomed && (
          <div className="pointer-events-none absolute inset-2 z-30 [&>*]:pointer-events-auto">
            {floating.map((rect) => {
              const leaf = findLeaf(workspace.layout, rect.leafId)
              if (!leaf) return null
              return (
                <FloatingPane key={rect.leafId} rect={rect} label={templateById(leaf.agentId ?? DEFAULT_TEMPLATE_ID).name}>
                  {renderLeaf(leaf, true)}
                </FloatingPane>
              )
            })}
          </div>
        )}
        <SnapBar layout={workspace.layout} drawerLeafIds={workspace.drawerLeafIds ?? []} />
      </div>
    </div>
  )
})

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

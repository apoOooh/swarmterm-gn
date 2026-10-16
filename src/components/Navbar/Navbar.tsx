import { memo, useEffect, useRef, useState, type ReactElement } from 'react'
import { Archive, ArrowDownToLine, Check, Columns2, GripHorizontal, LayoutGrid, MoreVertical, Pencil, Plus, Settings, X } from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GuardedPointerSensor } from '@/lib/dnd-sensors'
import { collectLeaves } from '@/lib/layout-tree'
import { useAppStore, type Workspace } from '@/store/app-store'
import { useNavbarVisibilityStore } from '@/store/navbar-visibility-store'
import { useSidebarPeekStore } from '@/store/sidebar-peek-store'
import { useEdgePeek } from '@/components/use-edge-peek'
import { AttentionBadge } from '@/components/Navbar/AttentionBadge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/components/AgentIcon'
import { TEMPLATES, isTemplateAvailable, templateById } from '@/lib/templates'
import { useAgentPrefStore } from '@/store/agent-pref-store'
import { useAgentAvailabilityStore } from '@/store/agent-availability-store'
import { cn } from '@/lib/utils'
import { TerminalList } from '@/components/Navbar/TerminalList'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { FileExplorer } from '@/components/Files/FileExplorer'
import { useSidebarLayoutStore } from '@/store/sidebar-layout-store'
import { useExplorerStore } from '@/store/explorer-store'
import { getAppVersion } from '@/tauri/app'

interface NavbarProps {
  /** Open the setup wizard to create a new workspace. */
  onNewWorkspace: () => void
  /** Whether the Settings page is currently open. */
  settingsOpen: boolean
  /** Toggle the Settings page open/closed. */
  onToggleSettings: () => void
}

/** Left navigation rail: the workspace list — add / switch / rename / close / reorder.
 * Drag an item to reorder (synced with the tab strip). Collapses to 0 width when
 * the title bar's toggle button is off.
 */
const MIN_WIDTH = 224
const MAX_WIDTH = 520
const WIDTH_KEY = 'swarmterm.sidebarWidth'
const clampWidth = (w: number): number => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w))

function loadWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(n) && n > 0 ? clampWidth(n) : 280
  } catch {
    return 280
  }
}

function saveWidth(w: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(w))
  } catch {
    // Width memory is a convenience; a blocked storage must not break resizing.
  }
}

export function Navbar(props: NavbarProps): ReactElement {
  const [sidebarWidth, setSidebarWidth] = useState(loadWidth)
  const [resizing, setResizing] = useState(false)
  const pendingX = useRef<number | null>(null)
  const frame = useRef<number | null>(null)
  const visible = useNavbarVisibilityStore((s) => s.visible)
  const peekEnabled = useSidebarPeekStore((s) => s.enabled)
  const navRef = useRef<HTMLElement>(null)
  // Peek: with the sidebar hidden, resting the pointer on the left edge slides
  // it in OVER the workspace; leaving it slides it back out.
  const edgePeek = useEdgePeek(!visible && peekEnabled, navRef)
  const peeking = edgePeek.peeking

  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }, [])

  const shown = visible || peeking
  const overlay = !visible && edgePeek.overlay

  // Pointer events can arrive several times per frame; commit at most one
  // width per frame so the layout (and every terminal refit behind it) runs
  // once per frame instead of once per event.
  function onPointerMove(x: number): void {
    pendingX.current = x
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      if (pendingX.current !== null) setSidebarWidth(clampWidth(pendingX.current))
    })
  }

  return (
    <>
    {edgePeek.showHotZone && (
      <div
        aria-hidden
        data-focus-return
        className="absolute inset-y-0 left-0 z-40 w-3"
        {...edgePeek.hotZoneProps}
      />
    )}
    <nav
      ref={navRef}
      aria-hidden={!shown}
      inert={!shown}
      // The whole sidebar hands the keyboard back to the terminal after a click
      // — workspace items, the terminal list, New workspace, Account, Settings.
      // Anything that legitimately claims focus (the rename input, a dropdown,
      // the Settings dialog) is exempt by lib/terminal-focus.ts's own check.
      data-focus-return
      style={{ width: shown ? sidebarWidth : 0 }}
      {...edgePeek.panelProps}
      // The width transition animates show/hide only. Left on during a drag,
      // every pointermove restarts a 200 ms animation: the edge trails the
      // pointer and the whole workspace area re-lays out every frame.
      className={cn(
        'h-full shrink-0 overflow-hidden border-r border-border bg-card',
        overlay ? 'absolute inset-y-0 left-0 z-40 shadow-2xl' : 'relative',
        !resizing && 'transition-[width] duration-200 ease-in-out motion-reduce:transition-none'
      )}
    >
      {overlay && <span hidden data-covers-webview />}
      {!overlay && <div
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        tabIndex={0}
        className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-col-resize hover:bg-ring focus:bg-ring"
        onPointerDown={(e) => { setResizing(true); e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={(e) => { if (resizing) onPointerMove(e.clientX) }}
        onPointerUp={(e) => {
          if (!resizing) return
          setResizing(false)
          e.currentTarget.releasePointerCapture(e.pointerId)
          const w = clampWidth(pendingX.current ?? sidebarWidth)
          pendingX.current = null
          setSidebarWidth(w)
          saveWidth(w)
        }}
        // A cancelled pointer (alt-tab, touch cancel) never sends pointerup.
        onLostPointerCapture={() => {
          setResizing(false)
          if (pendingX.current === null) return
          const w = clampWidth(pendingX.current)
          pendingX.current = null
          setSidebarWidth(w)
          saveWidth(w)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            const w = clampWidth(sidebarWidth + (e.key === 'ArrowRight' ? 16 : -16))
            setSidebarWidth(w)
            saveWidth(w)
          }
        }}
      />}
      <SidebarBody {...props} />
    </nav>
    </>
  )
}

/** Everything inside the rail. Memoized so a width change re-renders only the
 * <nav> shell, not the workspace list, terminal list and file explorer. */
const SidebarBody = memo(function SidebarBody({ onNewWorkspace, settingsOpen, onToggleSettings }: NavbarProps): ReactElement {
  const filesVisible = useExplorerStore((s) => s.visible)
  const sidebarLayout = useSidebarLayoutStore((s) => s.layout)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const welcomeFocused = useAppStore((s) => s.welcomeFocused)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const renameWorkspace = useAppStore((s) => s.renameWorkspace)
  const closeWorkspace = useAppStore((s) => s.closeWorkspace)
  const tidyLayout = useAppStore((s) => s.tidyLayout)
  const moveWorkspace = useAppStore((s) => s.moveWorkspace)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    // A missing version label must never break the navbar — swallow failures.
    getAppVersion()
      .then((v) => {
        if (active) setVersion(v)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const sensors = useSensors(
    useSensor(GuardedPointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const draggingWorkspace = workspaces.find((w) => w.id === draggingId) ?? null

  function handleDragStart(event: DragStartEvent): void {
    setDraggingId(String(event.active.id))
  }

  function handleDragEnd(event: DragEndEvent): void {
    setDraggingId(null)
    const { active, over } = event
    if (over && active.id !== over.id) {
      moveWorkspace(String(active.id), String(over.id))
    }
  }

  const workspacesSection = (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">Workspaces</p>
              <div className="flex items-center gap-1">
              <AttentionBadge />
              <button type="button" title={sidebarLayout === 'auto' ? 'Sidebar: Auto height — switch to Manual' : 'Sidebar: Manual — switch to Auto height'} aria-label="Toggle sidebar layout" aria-pressed={sidebarLayout === 'auto'}
                onClick={() => useSidebarLayoutStore.getState().setLayout(sidebarLayout === 'auto' ? 'manual' : 'auto')}
                className="-my-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                {sidebarLayout === 'auto' ? <ArrowDownToLine className="h-3.5 w-3.5" /> : <GripHorizontal className="h-3.5 w-3.5" />}
              </button>
            </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setDraggingId(null)}
            >
              <SortableContext
                items={workspaces.map((w) => w.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="space-y-0.5">
                  {workspaces.map((ws) => (
                    <WorkspaceItem
                      key={ws.id}
                      workspace={ws}
                      active={!welcomeFocused && ws.id === activeWorkspaceId}
                      renaming={renamingId === ws.id}
                      onSelect={() => setActiveWorkspace(ws.id)}
                      onStartRename={() => setRenamingId(ws.id)}
                      onCommitRename={(name) => {
                        renameWorkspace(ws.id, name)
                        setRenamingId(null)
                      }}
                      onCancelRename={() => setRenamingId(null)}
                      onTidy={() => tidyLayout(ws.id)}
                      onClose={() => closeWorkspace(ws.id)}
                    />
                  ))}
                </ul>
              </SortableContext>
              <DragOverlay>
                {draggingWorkspace ? (
                  <div aria-hidden className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1.5 text-sm text-accent-foreground shadow-lg">
                    <span className="flex-1 truncate">{draggingWorkspace.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {collectLeaves(draggingWorkspace.layout).length}
                    </span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 w-full justify-start text-muted-foreground"
              onClick={onNewWorkspace}
            >
              <Plus className="h-4 w-4" />
              New workspace
            </Button>
            </div>
          </div>
    )

  return (
      <div className="flex h-full w-full flex-col">
        {sidebarLayout === 'manual' ? (
        <Group orientation="vertical" className="min-h-0 flex-1" defaultLayout={{ workspaces: 25, terminals: 25, files: 50 }}>
        <Panel id="workspaces" minSize="10%">{workspacesSection}</Panel>
        <Separator className="h-1 cursor-row-resize bg-border hover:bg-ring" />
        <Panel id="terminals" minSize="10%" className="flex min-h-0 flex-col"><TerminalList /></Panel>
        <Separator className="h-1 cursor-row-resize bg-border hover:bg-ring" />
        <Panel id="files" minSize="36px" maxSize={filesVisible ? '100%' : '36px'}><FileExplorer /></Panel>
        </Group>
        ) : (
        // Auto: lists take their content height (each capped at 35 %, then they
        // scroll inside), Files gets everything left — a new workspace or pane
        // grows its list and pushes the explorer down instead of scrolling a
        // fixed quarter of the rail.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex max-h-[35%] min-h-0 shrink-0 flex-col">{workspacesSection}</div>
          <div className="flex max-h-[35%] min-h-0 shrink-0 flex-col"><TerminalList /></div>
          <div className="min-h-[36px] flex-1 overflow-hidden border-t border-border"><FileExplorer /></div>
        </div>
        )}

        <div className="shrink-0 space-y-0.5 border-t border-border p-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleSettings}
            className={cn(
              'w-full justify-start',
              settingsOpen
                ? 'bg-accent text-accent-foreground hover:bg-accent'
                : 'text-muted-foreground'
            )}
            title="Settings"
          >
            <Settings className="h-4 w-4" />
            Settings
          </Button>
          {version && (
            <p className="mt-1 border-t border-border pt-2 text-center text-[11px] tracking-wider text-muted-foreground/70">
              v{version}
            </p>
          )}
        </div>
      </div>
  )
})

interface WorkspaceItemProps {
  workspace: Workspace
  active: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  onCommitRename: (name: string) => void
  onCancelRename: () => void
  onTidy: () => void
  onClose: () => void
}

function WorkspaceItem({
  workspace,
  active,
  renaming,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onTidy,
  onClose
}: WorkspaceItemProps): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id,
    disabled: renaming
  })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const paneCount = collectLeaves(workspace.layout).length
  const drawerCount = workspace.drawerLeafIds?.length ?? 0

  if (renaming) {
    return (
      <li ref={setNodeRef} style={style}>
        <RenameInput
          initialValue={workspace.name}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      </li>
    )
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      // Out of the tab order for the same reason as the workspace tabs — the
      // item has no keyboard action, and a stray Tab belongs to the shell.
      tabIndex={-1}
      className={cn(isDragging && 'opacity-40')}
    >
      <div
        onClick={onSelect}
        className={cn(
          'group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm',
          active
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        )}
      >
        <span className="flex-1 truncate">{workspace.name}</span>
        {drawerCount > 0 && (
          <span
            className="flex items-center gap-0.5 text-xs tabular-nums text-muted-foreground"
            title={`${drawerCount} in drawer`}
          >
            <Archive className="h-3 w-3" aria-hidden="true" />
            {drawerCount}
          </span>
        )}
        <span className="text-xs tabular-nums text-muted-foreground" title={`${paneCount} terminals`}>{paneCount}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              data-no-dnd
              onClick={(e) => e.stopPropagation()}
              className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-background/80 group-hover:opacity-100 data-[state=open]:opacity-100"
              title="Workspace actions"
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onStartRename}>
              <Pencil className="h-3.5 w-3.5" />
              Rename
            </DropdownMenuItem>
            <WorkspaceDefaultAgentMenu workspace={workspace} />
            <DropdownMenuItem onSelect={onTidy} disabled={paneCount < 2}>
              <LayoutGrid className="h-3.5 w-3.5" />
              Tidy layout
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onClose}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <X className="h-3.5 w-3.5" />
              Close
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

/**
 * "Split opens…" submenu: the per-workspace default agent for split panes.
 * "Settings default" clears the override so the workspace follows the global
 * choice live, instead of freezing a copy of it.
 */
function WorkspaceDefaultAgentMenu({ workspace }: { workspace: Workspace }): ReactElement {
  const setDefault = useAppStore((s) => s.setWorkspaceDefaultAgent)
  const globalDefault = useAgentPrefStore((s) => s.defaultAgentId)
  const availability = useAgentAvailabilityStore((s) => s.availability)
  const current = workspace.defaultAgentId
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Columns2 className="h-3.5 w-3.5" />
        Split opens…
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
        <DropdownMenuItem onSelect={() => setDefault(workspace.id, undefined)}>
          <Check aria-hidden="true" className={cn('h-3.5 w-3.5', current === undefined ? 'opacity-100' : 'opacity-0')} />
          <span>Settings default</span>
          <span className="ml-auto pl-3 text-xs text-muted-foreground">{templateById(globalDefault).name}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {TEMPLATES.map((t) => {
          const available = isTemplateAvailable(t, availability)
          return (
            <DropdownMenuItem key={t.id} disabled={!available} onSelect={() => setDefault(workspace.id, t.id)}>
              <Check aria-hidden="true" className={cn('h-3.5 w-3.5', current === t.id ? 'opacity-100' : 'opacity-0')} />
              <AgentIcon template={t} className="h-4 w-4 shrink-0" />
              <span>{t.name}</span>
              {!available && <span className="ml-auto pl-3 text-xs text-muted-foreground">Not installed</span>}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

interface RenameInputProps {
  initialValue: string
  onCommit: (name: string) => void
  onCancel: () => void
}

function RenameInput({ initialValue, onCommit, onCancel }: RenameInputProps): ReactElement {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef(false)

  // Defer focus past Radix's focus-restore so the input reliably wins.
  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  const finish = (commit: boolean): void => {
    if (doneRef.current) return
    doneRef.current = true
    if (commit) onCommit(value)
    else onCancel()
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
      className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

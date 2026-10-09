import { useEffect, useRef, useState, type ReactElement } from 'react'
import { MoreVertical, Pencil, Plus, Settings, X } from 'lucide-react'
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
import { AttentionBadge } from '@/components/Navbar/AttentionBadge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { TerminalList } from '@/components/Navbar/TerminalList'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { FileExplorer } from '@/components/Files/FileExplorer'
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
export function Navbar({ onNewWorkspace, settingsOpen, onToggleSettings }: NavbarProps): ReactElement {
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const resizing = useRef(false)
  const filesVisible = useExplorerStore((s) => s.visible)
  const visible = useNavbarVisibilityStore((s) => s.visible)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const welcomeFocused = useAppStore((s) => s.welcomeFocused)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const renameWorkspace = useAppStore((s) => s.renameWorkspace)
  const closeWorkspace = useAppStore((s) => s.closeWorkspace)
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

  return (
    <nav
      aria-hidden={!visible}
      inert={!visible}
      // The whole sidebar hands the keyboard back to the terminal after a click
      // — workspace items, the terminal list, New workspace, Account, Settings.
      // Anything that legitimately claims focus (the rename input, a dropdown,
      // the Settings dialog) is exempt by lib/terminal-focus.ts's own check.
      data-focus-return
      style={{ width: visible ? sidebarWidth : 0 }}
      className="relative h-full shrink-0 overflow-hidden border-r border-border bg-card transition-[width] duration-200 ease-in-out motion-reduce:transition-none"
    >
      <div role="separator" aria-label="Resize sidebar" aria-orientation="vertical" tabIndex={0} className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-col-resize hover:bg-ring focus:bg-ring" onPointerDown={(e) => { resizing.current = true; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={(e) => { if (resizing.current) setSidebarWidth(Math.max(224, Math.min(520, e.clientX))) }} onPointerUp={(e) => { resizing.current = false; e.currentTarget.releasePointerCapture(e.pointerId) }} onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setSidebarWidth((w) => Math.max(224, Math.min(520, w + (e.key === 'ArrowRight' ? 16 : -16)))) } }} />
      <div className="flex h-full w-full flex-col">
        <Group orientation="vertical" className="min-h-0 flex-1" defaultLayout={{ workspaces: 25, terminals: 25, files: 50 }}>
        <Panel id="workspaces" minSize="10%">

        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">Workspaces</p>
            <AttentionBadge />
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

        </Panel>
        <Separator className="h-1 cursor-row-resize bg-border hover:bg-ring" />
        <Panel id="terminals" minSize="10%" className="flex min-h-0 flex-col"><TerminalList /></Panel>
        <Separator className="h-1 cursor-row-resize bg-border hover:bg-ring" />
        <Panel id="files" minSize="36px" maxSize={filesVisible ? '100%' : '36px'}><FileExplorer /></Panel>
        </Group>

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
    </nav>
  )
}

interface WorkspaceItemProps {
  workspace: Workspace
  active: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  onCommitRename: (name: string) => void
  onCancelRename: () => void
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
  onClose
}: WorkspaceItemProps): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id,
    disabled: renaming
  })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const paneCount = collectLeaves(workspace.layout).length

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
        <span className="text-xs tabular-nums text-muted-foreground">{paneCount}</span>
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

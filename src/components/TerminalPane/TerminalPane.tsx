import { useMemberConnection } from '@/components/WarRoom/useMemberConnection'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { DockPicker } from '@/components/TerminalPane/DockPicker'
import type { LeafNode } from '@/lib/layout-tree'
import { collectLeaves } from '@/lib/layout-tree'
import { useAppStore, type ClearTarget } from '@/store/app-store'
import { useTerminalPrefStore } from '@/store/terminal-pref-store'
import { useAgentPrefStore } from '@/store/agent-pref-store'
import { useAgentAvailabilityStore } from '@/store/agent-availability-store'
import { resolveLaunchMode, resolveSplitAgent } from '@/lib/agent-pref'
import { useTerminalTitleStore } from '@/store/terminal-title-store'
import { useTerminalSearchStore } from '@/store/terminal-search-store'
import { useContextUsageStore } from '@/store/context-usage-store'
import { Button } from '@/components/ui/button'
import { HeldDeliveryPill } from '@/components/TerminalPane/HeldDeliveryPill'
import { SearchOverlay } from '@/components/TerminalPane/SearchOverlay'
import { PaneHeader } from './PaneHeader'
import { HandoffBriefDialog } from './HandoffBriefDialog'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { accountLabel } from '@/lib/agent-accounts'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu'
import { ClearWorktreeDialog, type DialogTarget } from '@/components/Workspace/ClearWorktreeDialog'
import { getChangedFiles, branchUnmergedCount } from '@/tauri/git'
import { classifyWorktree, clearWorktreeMenuLabel } from '@/lib/worktree-cleanup'
import { agentCommand, DEFAULT_TEMPLATE_ID, templateById, withLaunchMode } from '@/lib/templates'
import { buildAgentSpawnCommand, shellFlavor } from '@/lib/agent-spawn-command'
import { buildContinueCommand, buildResumeCommand } from '@/lib/resume-command'
import { isWindowsPlatform } from '@/lib/platform'
import { pickFolder } from '@/store/folder-picker-store'
import { cn } from '@/lib/utils'
import { startPointerDrag, type DragHit } from '@/lib/pointer-drag-session'
import { insertExplorerPaths } from '@/components/FileDropListener'
import { devLog } from '@/lib/dev-log'
import {
  attachTerminal,
  detachTerminal,
  focusTerminal,
  getTerminalStatus,
  getHoveredPathLink,
  openPathLink,
  respawnTerminal,
  retryTerminal,
  subscribeTerminalStatus,
  type TerminalStatus
} from '@/lib/terminal-registry'

interface TerminalPaneProps {
  leaf: LeafNode
  /** Working directory the terminal's shell starts in. */
  cwd: string
  isFocused: boolean
  /** Whether broadcast mode is armed for this workspace. */
  broadcastActive: boolean
  /** Whether this pane is in the broadcast group. */
  isBroadcastMember: boolean
  /** Whether the workspace exposes MCP worktree tools to every terminal. */
  worktreeMode: boolean
  /** Whether this pane is zoomed to fill its workspace. */
  isZoomed?: boolean
  /** Whether this pane floats above the split view. */
  isFloating?: boolean
}

/**
 * One terminal pane: a mount point for a live terminal owned by the registry.
 * The xterm instance and its pty persist in the registry across mounts, so
 * this component only attaches/detaches the terminal's DOM — closing a sibling
 * pane (which remounts this one as the split tree collapses) no longer kills or
 * re-spawns the shell. The pty is killed only when the leaf is truly removed.
 */
export function TerminalPane({
  leaf,
  cwd,
  isFocused,
  broadcastActive,
  isBroadcastMember,
  worktreeMode,
  isZoomed = false,
  isFloating = false
}: TerminalPaneProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)

  const splitPane = useAppStore((s) => s.splitPane)
  const closePane = useAppStore((s) => s.closePane)
  const setFocusedLeaf = useAppStore((s) => s.setFocusedLeaf)
  const toggleBroadcastMember = useAppStore((s) => s.toggleBroadcastMember)
  const setPaneAccount = useAppStore(s => s.setPaneAccount)
  const setPaneAgent = useAppStore((s) => s.setPaneAgent)
  const setPaneLaunchMode = useAppStore((s) => s.setPaneLaunchMode)
  const seedPaneLaunchMode = useAppStore((s) => s.seedPaneLaunchMode)
  const defaultLaunchModes = useAgentPrefStore((s) => s.defaultLaunchModes)
  const pickPaneSession = useAppStore((s) => s.pickPaneSession)
  const setPaneCwd = useAppStore((s) => s.setPaneCwd)
  const setPaneShell = useAppStore((s) => s.setPaneShell)
  const clearWorktrees = useAppStore((s) => s.clearWorktrees)
  const globalShellId = useTerminalPrefStore((s) => s.shellId)
  const isDropTarget = useAppStore((s) => s.dropTargetTerminalId === leaf.terminalId)
  const workspaceDefaultAgent = useAppStore(
    (s) => s.workspaces.find((w) => collectLeaves(w.layout).some((l) => l.id === leaf.id))?.defaultAgentId
  )
  const globalDefaultAgent = useAgentPrefStore((s) => s.defaultAgentId)
  const agentAvailability = useAgentAvailabilityStore((s) => s.availability)
  const splitAgentFor = (plain: boolean): string =>
    resolveSplitAgent({
      workspaceDefault: workspaceDefaultAgent,
      globalDefault: globalDefaultAgent,
      availability: agentAvailability,
      forcePlain: plain
    })

  const { id: leafId, terminalId } = leaf

  const agentTitle = useTerminalTitleStore((s) => s.titles[terminalId])
  // Per-terminal selector: only this pane wakes when ITS number changes, and the
  // store returns the same state on a no-change sample, so streaming stays quiet.
  const ctxPct = useContextUsageStore((s) => s.byId[terminalId])
  const warRoomStatus = useMemberConnection(terminalId)
  // Narrow boolean selector: only THIS pane re-renders when the find overlay
  // opens/closes for it, not every pane on every keystroke in some other one
  // (the overlay owns its own query/toggle state, not the store).
  const searchOpen = useTerminalSearchStore((s) => s.openFor === terminalId)

  // Reorder-DnD: the whole pane root is both the drop target AND the draggable
  // node (so the drag overlay assumes the pane's size); the header (below) is the
  // grab handle via setActivatorNodeRef. Both keyed by leafId — dnd-kit keeps the
  // draggable and droppable namespaces separate, so the shared id is fine. The
  // live terminal is keyed by terminalId in the registry, so a reorder only
  // re-parents this pane's DOM, never killing the shell.
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: leafId })
  const {
    setNodeRef: setDragRef,
    setActivatorNodeRef,
    listeners: dragListeners,
    attributes: dragAttributes,
    isDragging
  } = useDraggable({ id: leafId })

  // The pane root carries both refs (drop target + draggable node).
  const setPaneRef = (el: HTMLDivElement | null): void => {
    setDropRef(el)
    setDragRef(el)
  }

  // Resolve each per-pane value against its default.
  const resolvedCwd = leaf.cwd ?? cwd
  const resolvedShellId = leaf.shellId ?? globalShellId
  const resolvedAgentId = leaf.agentId ?? DEFAULT_TEMPLATE_ID
  const rawCommand = agentCommand(resolvedAgentId)
  // Pane choice → Settings default → template default; seeded into the leaf
  // below so the pane keeps it when the Settings default changes later.
  const resolvedLaunchMode = resolveLaunchMode(resolvedAgentId, leaf.launchMode, defaultLaunchModes)
  // Launch-mode args ride on every spawn form (fresh, brief, resume, continue).
  const baseCommand =
    rawCommand === undefined ? undefined : withLaunchMode(rawCommand, resolvedAgentId, resolvedLaunchMode)
  // A resume pane re-enters a session the CLI recorded on disk; the resume
  // line wins over the worker-brief path (a resume leaf never carries
  // initialPrompt — see createWorkspace).
  const resumeCommand =
    leaf.resumeSessionId !== undefined
      ? buildResumeCommand(resolvedAgentId, leaf.resumeSessionId, resolvedLaunchMode)
      : leaf.continueSession !== undefined
        ? buildContinueCommand(resolvedAgentId, resolvedLaunchMode, leaf.continueSession)
        : undefined
  // Worker panes carry a one-shot task brief; quote it for the shell the pty
  // actually types into (initialCommand is a typed line, not an exec).
  const resolvedCommand =
    leaf.startupCommand ??
    resumeCommand ??
    (baseCommand !== undefined && leaf.initialPrompt !== undefined
      ? buildAgentSpawnCommand(
          baseCommand,
          leaf.initialPrompt,
          shellFlavor(resolvedShellId, isWindowsPlatform()),
          templateById(resolvedAgentId).spawnPromptFlag
        )
      : baseCommand)
  useEffect(() => {
    if (leaf.launchMode === undefined && resolvedLaunchMode !== undefined) {
      seedPaneLaunchMode(leaf.id, resolvedLaunchMode)
    }
  }, [leaf.id, leaf.launchMode, resolvedLaunchMode, seedPaneLaunchMode])
  // Published to the DOM so the app-level file-drop listener can quote paths
  // for this pane's shell without re-deriving the resolution chain.
  const paneShellFlavor = shellFlavor(resolvedShellId, isWindowsPlatform())

  const [status, setStatus] = useState<TerminalStatus>(() => getTerminalStatus(terminalId))

  // Attach the live terminal to this pane's container and mirror its status.
  // Keyed on terminalId only: remounts (sibling close → tree collapse) re-attach
  // the same live terminal; config changes are handled by the respawn effect.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    attachTerminal(terminalId, container, {
      cwd: resolvedCwd,
      shellId: resolvedShellId,
      initialCommand: resolvedCommand,
      worktreeMode: worktreeMode || undefined,
      repoRoot: worktreeMode ? cwd : undefined,
      agentId: resolvedAgentId,
      accountId: leaf.accountId
    })
    setStatus(getTerminalStatus(terminalId))
    const unsubscribe = subscribeTerminalStatus(terminalId, () =>
      setStatus(getTerminalStatus(terminalId))
    )

    return () => {
      unsubscribe()
      detachTerminal(terminalId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId])

  // Respawn the pty when a resolved value changes after mount. The ref starts at
  // the mount-time values, so the first run is a no-op (no respawn on mount or
  // remount); only a genuine agent/path/shell switch triggers a restart.
  const appliedRef = useRef({
    cwd: resolvedCwd,
    shellId: resolvedShellId,
    command: resolvedCommand,
    agentId: resolvedAgentId,
    accountId: leaf.accountId
  })
  useEffect(() => {
    const prev = appliedRef.current
    if (
      prev.cwd === resolvedCwd &&
      prev.shellId === resolvedShellId &&
      prev.command === resolvedCommand &&
      prev.agentId === resolvedAgentId &&
      prev.accountId === leaf.accountId
    ) {
      return
    }
    appliedRef.current = {
      cwd: resolvedCwd,
      shellId: resolvedShellId,
      command: resolvedCommand,
      agentId: resolvedAgentId,
      accountId: leaf.accountId
    }
    respawnTerminal(terminalId, {
      cwd: resolvedCwd,
      shellId: resolvedShellId,
      initialCommand: resolvedCommand,
      worktreeMode: worktreeMode || undefined,
      repoRoot: worktreeMode ? cwd : undefined,
      agentId: resolvedAgentId,
      accountId: leaf.accountId
    })
    // A same-id respawn (agent/cwd/shell switch) starts a new session; the old
    // agent's title no longer describes it. Clear it — the new agent re-titles.
    useTerminalTitleStore.getState().clearTitle(terminalId)
  }, [terminalId, resolvedCwd, resolvedShellId, resolvedCommand, resolvedAgentId, leaf.accountId])

  // Pull keyboard focus into xterm when this pane becomes the focused one.
  useEffect(() => {
    if (isFocused) focusTerminal(terminalId)
  }, [isFocused, terminalId])

  async function handleChoosePath(): Promise<void> {
    // Start in the workspace folder, not the OS default (home).
    const dir = await pickFolder(cwd)
    if (dir) setPaneCwd(leafId, dir)
  }

  const [handoffOpen, setHandoffOpen] = useState(false)
  const accounts = useAgentAccountsStore((st) => st.accounts)
  const [dialog, setDialog] = useState<{ targets: DialogTarget[]; clears: ClearTarget[] } | null>(null)
  // Lazily computed when the context menu opens (see the ContextMenu wrapper
  // below) rather than on every render of every pane.
  const [menuTargetCount, setMenuTargetCount] = useState(0)

  // Resolve which panes this action targets: the broadcast group if THIS leaf is
  // in it, else just this pane — then keep only panes bound to a worktree.
  function resolveWorktreeTargets(): ClearTarget[] {
    const st = useAppStore.getState()
    const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)
    if (!ws) return []
    const inGroup = ws.broadcastLeafIds.includes(leafId)
    const leaves = collectLeaves(ws.layout).filter((l) =>
      inGroup ? ws.broadcastLeafIds.includes(l.id) : l.id === leafId
    )
    return leaves
      .filter((l) => l.worktreeBranch !== undefined && l.cwd !== undefined)
      .map((l) => ({
        leafId: l.id,
        terminalId: l.terminalId,
        path: l.cwd as string,
        branch: l.worktreeBranch as string,
        repoRoot: ws.cwd
      }))
  }

  async function openClearDialog(): Promise<void> {
    const clears = resolveWorktreeTargets()
    if (clears.length === 0) return
    const targets: DialogTarget[] = await Promise.all(
      clears.map(async (c) => {
        try {
          const changed = await getChangedFiles(c.path)
          const unmerged = await branchUnmergedCount(c.repoRoot, c.branch)
          const { uncommittedCount, unmergedCount, dirty } = classifyWorktree(changed, unmerged)
          return { leafId: c.leafId, branch: c.branch, uncommittedCount, unmergedCount, dirty }
        } catch (e) {
          // An uninspectable worktree is treated as having unsaved work so it is
          // protected (unchecked), never silently auto-removed.
          console.warn(`inspect worktree failed for ${c.branch}:`, e)
          return { leafId: c.leafId, branch: c.branch, uncommittedCount: 0, unmergedCount: 0, dirty: true }
        }
      })
    )
    setDialog({ targets, clears })
  }

  function confirmClear(approvedLeafIds: string[]): void {
    if (!dialog) return
    const approved = dialog.clears.filter((c) => approvedLeafIds.includes(c.leafId))
    void clearWorktrees(approved)
    setDialog(null)
  }

  const pane = (
    <div
      ref={setPaneRef}
      onMouseDown={(e) => {
        // Alt+Click adds/removes this pane from the broadcast group instead of
        // focusing it. Ctrl/Cmd is avoided — xterm's WebLinks addon uses it.
        if (e.altKey) {
          e.preventDefault()
          toggleBroadcastMember(leafId)
          return
        }
        setFocusedLeaf(leafId)
      }}
      // Clicking pane chrome (header, borders) blurs xterm; App.tsx returns the
      // keyboard to the terminal on the way back up (lib/terminal-focus.ts).
      data-focus-return
      // Ctrl+press on a detected file path: a drag carries it to another pane
      // (path / @ mention, like a Files drag); released in place it opens the
      // link exactly as Ctrl+click did. Captured before xterm so the press
      // doesn't start a text selection.
      onMouseDownCapture={(e) => {
        if (e.button !== 0 || !(isWindowsPlatform() ? e.ctrlKey : e.metaKey)) return
        const link = getHoveredPathLink(terminalId)
        if (!link) return
        e.preventDefault()
        e.stopPropagation()
        const native = e.nativeEvent
        const hit = (x: number, y: number): DragHit => {
          const pane = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-terminal-id]')
          const target = pane?.dataset.terminalId
          return target && target !== terminalId ? { effect: 'copy', terminalId: target } : { effect: 'none' }
        }
        startPointerDrag(e, { name: 'terminal-link', items: [link.resolved], hit,
          drop: (_x, _y, _c, h) => { if (h.terminalId) insertExplorerPaths(h.terminalId, [link.resolved]) },
          onTap: () => { devLog('terminal-link.tap', { text: link.text }); openPathLink(terminalId, native, link.text) } })
      }}
      data-terminal-id={terminalId}
      data-leaf-id={leafId}
      data-shell-flavor={paneShellFlavor}
      data-agent-id={resolvedAgentId}
      data-cwd={resolvedCwd}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md border bg-background',
        isFocused
          ? 'border-ring'
          : isBroadcastMember
            ? 'border-broadcast'
            : 'border-pane-border',
        // Dim non-members while the mode is on, so the group reads at a glance.
        broadcastActive && !isBroadcastMember && 'opacity-60',
        // Drop-target ring while another pane is dragged over this one.
        isOver && !isDragging && 'ring-2 ring-inset ring-ring',
        // OS file drag hovering this pane — same affordance as the pane-reorder
        // drop ring, in the accent color so the two gestures read differently.
        isDropTarget && 'ring-2 ring-inset ring-primary',
        // Dim the pane being dragged, so the lifted ghost reads as the "real" one.
        isDragging && 'opacity-40'
      )}
    >
      <PaneHeader
        agentId={resolvedAgentId}
        accountId={leaf.accountId}
        onAccountChange={accountId => setPaneAccount(leafId, accountId)}
        shellId={resolvedShellId}
        resolvedCwd={resolvedCwd}
        hasCwdOverride={leaf.cwd !== undefined}
        launchModeId={resolvedLaunchMode}
        onAgentChange={(id) => setPaneAgent(leafId, id)}
        onLaunchModeChange={(id) => setPaneLaunchMode(leafId, id)}
        onPickSession={() => pickPaneSession(leafId)}
        onShellChange={(id) => setPaneShell(leafId, id)}
        onChoosePath={() => void handleChoosePath()}
        onResetPath={() => setPaneCwd(leafId, undefined)}
        onSplitRight={(plain) => splitPane(leafId, 'horizontal', splitAgentFor(plain))}
        onSplitDown={(plain) => splitPane(leafId, 'vertical', splitAgentFor(plain))}
        splitAgentName={templateById(splitAgentFor(false)).name}
        onClose={() => closePane(leafId)}
        onHandoff={() => setHandoffOpen(true)}
        onDrawer={() => useAppStore.getState().drawerPane(leafId)}
        isZoomed={isZoomed}
        onToggleZoom={() => useAppStore.getState().toggleZoom(leafId)}
        isFloating={isFloating}
        onToggleFloat={() => {
          const st = useAppStore.getState()
          if (isFloating) st.dockFloatingPane(leafId)
          else st.floatPane(leafId)
        }}
        broadcastActive={broadcastActive}
        isBroadcastMember={isBroadcastMember}
        onToggleBroadcast={() => toggleBroadcastMember(leafId)}
        dragHandleRef={setActivatorNodeRef}
        dragListeners={dragListeners}
        dragAttributes={dragAttributes}
        worktreeBranch={leaf.worktreeBranch}
        agentTitle={agentTitle}
        ctxPct={ctxPct}
        warRoom={warRoomStatus}
      />

      <HandoffBriefDialog
        open={handoffOpen}
        onClose={() => setHandoffOpen(false)}
        terminalId={terminalId}
        leafId={leaf.id}
        agentName={templateById(resolvedAgentId).name}
        accountLabel={leaf.accountId === undefined ? undefined : accountLabel(leaf.accountId, accounts)}
        cwd={resolvedCwd}
        sessionId={leaf.sessionId}
      />

      <ClearWorktreeDialog
        open={dialog !== null}
        targets={dialog?.targets ?? []}
        onConfirm={confirmClear}
        onClose={() => setDialog(null)}
      />

      <div className="relative flex-1 overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" />

        <HeldDeliveryPill terminalId={terminalId} />
        <DockPicker leafId={leafId} />
        {searchOpen && <SearchOverlay terminalId={terminalId} />}

        {status.kind === 'error' && (
          <StatusOverlay
            title="Could not start the terminal"
            detail={status.message}
            actionLabel="Retry"
            onAction={() => retryTerminal(terminalId)}
          />
        )}
        {status.kind === 'exited' && (
          <StatusOverlay
            title="Process exited"
            detail={`Exit code ${status.exitCode}`}
            actionLabel="Restart"
            onAction={() => retryTerminal(terminalId)}
          />
        )}
      </div>
    </div>
  )

  // Right-click anywhere in the pane (header or the terminal body) opens the
  // context menu — the whole pane is the trigger, not just the header. xterm
  // doesn't use right-click, so capturing it here steals no terminal action.
  return (
    <ContextMenu onOpenChange={(open) => { if (open) setMenuTargetCount(resolveWorktreeTargets().length) }}>
      <ContextMenuTrigger asChild>{pane}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={menuTargetCount === 0}
          onSelect={() => void openClearDialog()}
        >
          {clearWorktreeMenuLabel(menuTargetCount)}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface StatusOverlayProps {
  title: string
  detail: string
  actionLabel: string
  onAction: () => void
}

function StatusOverlay({ title, detail, actionLabel, onAction }: StatusOverlayProps): React.ReactElement {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-4 text-center">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 max-w-sm break-words text-xs text-muted-foreground">{detail}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onAction}>
        <RotateCw className="h-3.5 w-3.5" />
        {actionLabel}
      </Button>
    </div>
  )
}

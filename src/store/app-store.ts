import { toggledZoom } from '@/lib/pane-zoom'
import { drawerAfterRemoval, nextVisibleLeafId } from '@/lib/pane-drawer'
import { clampFloatRect, floatingAfterRemoval, floatPane, hiddenLeafIds, isFloating, unfloatPane, type FloatRect } from '@/lib/floating-panes'
import { create, type StateCreator } from 'zustand'
import {
  paneLayoutFor,
  collectLeaves,
  closeLeaf,
  findLeaf,
  resizeSplit,
  equalizeSplit,
  splitLeaf,
  reorderLeaves,
  moveLeafBeside,
  tidyLayout,
  updateLeaf,
  type Direction,
  type DockSide,
  type LayoutNode,
  type LeafNode
} from '@/lib/layout-tree'
import type { ShellId } from '@/lib/terminal-pref'
import { withCloseGuard } from '@/lib/close-guard'
import { DEFAULT_TEMPLATE_ID } from '@/lib/templates'
import { clearWorktree } from '@/tauri/git'
import { isTransientLock } from '@/lib/worktree-cleanup'
import { awaitTerminalRelocated } from '@/lib/terminal-registry'
import { workspaceNameFor } from '@/lib/workspace-name'
import { applyPreset } from '@/lib/layout-presets'
import { fromSaved, type ReattachLeaf, type SavedLeaf, type SavedWorkspace } from '@/lib/saved-workspaces'
import { isValidSessionId } from '@/lib/resume-command'
import { sanitizePaneName } from '@/lib/pane-address'
import { splitAccountFor, type AccountSelection } from '@/lib/agent-accounts'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'

/** A workspace: a named binary split-tree of terminal panes. */
export interface Workspace {
  id: string
  /** Absent after Forget: this live instance must no longer auto-save. */
  savedId?: string
  name: string
  /** Working directory every terminal in this workspace starts from. */
  cwd: string
  layout: LayoutNode
  focusedLeafId: string
  /** Whether broadcast (keystroke fan-out) is armed for this workspace. */
  broadcastActive: boolean
  /** Leaf ids that receive broadcast keystrokes while `broadcastActive`. */
  broadcastLeafIds: string[]
  /** Enable MCP worktree tools for every terminal in this workspace. */
  worktreeMode: boolean
  /** Leaf shown alone (pane zoom); the others keep running off-screen. */
  zoomedLeafId?: string
  /** Leaves parked in the drawer: hidden from the split view but still in
   *  `layout`, so their pty/xterm keep running (see lib/pane-drawer.ts).
   *  Absent ⇒ empty. Order = drawer order (oldest first). */
  drawerLeafIds?: string[]
  /** Leaves shown as floating windows above the split view; like the drawer
   *  they stay in `layout` (see lib/floating-panes.ts). Absent ⇒ none.
   *  Order = stacking order (last on top). Not persisted. */
  floating?: FloatRect[]
  /** Agent a split pane starts with in this workspace (template id).
   *  Absent ⇒ inherit the global default from Settings (agent-pref-store). */
  defaultAgentId?: string
  /** Account choice per agent CLI from the composer, applied to split panes
   *  (see `splitAccountFor`). Absent ⇒ splits inherit the source pane's account. */
  accountSelections?: Record<string, AccountSelection>
}

/** Whether `leafId` is parked in `ws`'s drawer. */
export function isDrawered(ws: Workspace, leafId: string): boolean {
  return ws.drawerLeafIds?.includes(leafId) ?? false
}

/** Leaves of `ws` currently on screen (i.e. not drawered), in layout order. */
export function visibleLeaves(ws: Workspace): LeafNode[] {
  return collectLeaves(ws.layout).filter((l) => !isDrawered(ws, l.id))
}

/**
 * The focused leaf, or undefined while it sits in the drawer. The focus id
 * stays on a drawered leaf only when every pane is parked; anything that
 * "follows the focused pane" (notifications' watched check, seen-marking,
 * search, preview column, Git/Files panels) must then follow nothing rather
 * than a pane the user cannot see.
 */
export function focusedVisibleLeaf(ws: Workspace): LeafNode | undefined {
  if (isDrawered(ws, ws.focusedLeafId)) return undefined
  return findLeaf(ws.layout, ws.focusedLeafId) ?? undefined
}

/** Focus `leafId`, pulling it out of the drawer and ending any zoom that hides it. */
function focusLeaf(w: Workspace, leafId: string): Workspace {
  return {
    ...w,
    focusedLeafId: leafId,
    zoomedLeafId: w.zoomedLeafId && w.zoomedLeafId !== leafId ? undefined : w.zoomedLeafId,
    drawerLeafIds: isDrawered(w, leafId) ? w.drawerLeafIds!.filter((id) => id !== leafId) : w.drawerLeafIds
  }
}

/** What the setup wizard collects to build a new workspace. */
export interface CreateWorkspaceConfig {
  cwd: string
  /** Number of terminal panes; must be a value from TERMINAL_COUNTS. */
  terminalCount: number
  /** One agent id per pane, in build order. Short arrays are padded with
   *  DEFAULT_TEMPLATE_ID so `agentIds.length` need not equal `terminalCount`,
   *  but the caller should keep them in sync. */
  agentIds: string[]
  accountIds?: (string | undefined)[]
  /** Explicit shell commands for profile login; never saved in workspace snapshots. */
  startupCommands?: (string | undefined)[]
  /** Enable MCP worktree tools for every terminal in this workspace. */
  worktreeMode?: boolean
  /** Per-pane worktree assignment, index-aligned with agentIds; null = pane
   *  stays at the workspace cwd. Created by the composer BEFORE the store is
   *  touched, so leaves are born with their isolation — no post-hoc rebinding. */
  paneWorktrees?: ({ path: string; branch: string } | null)[]
  /** Sessions to resume, one extra pane each, appended after the stepper
   *  panes. `cwd` is the session's recorded directory — resume commands only
   *  find their session when run from where it was recorded, so these panes
   *  are exempt from worktree provisioning. */
  resumePanes?: Array<{ agentId: string; sessionId: string; cwd: string; accountId?: string }>
  /** Per-workspace default split agent; absent ⇒ the global default. */
  defaultAgentId?: string
  /** Workspace account choice per agent CLI, kept for later splits. */
  accountSelections?: Record<string, AccountSelection>
}

/** One worktree to clear: the bound leaf, its worktree path + branch, and the repo root. */
export interface ClearTarget {
  leafId: string
  terminalId: string
  path: string
  branch: string
  repoRoot: string
}

export interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string
  /** Monotonic counter — the "Workspace N" fallback name when no cwd is picked. */
  nextWorkspaceNumber: number
  /** Whether the Welcome tab exists in the tab strip. */
  welcomeOpen: boolean
  /** Whether the Welcome tab (vs the active workspace) is the foreground view. */
  welcomeFocused: boolean
  /** Draft working folder shown in the Welcome form (shared with the title-bar search). */
  welcomeFolder: string
  /**
   * Terminal the OS drag is currently hovering, for the drop-target ring.
   * Transient: set on drag enter/over, cleared on drop or leave.
   */
  dropTargetTerminalId: string | null
}

export interface AppActions {
  createWorkspace: (config: CreateWorkspaceConfig) => void
  /** `reattach` names saved panes still running in the terminal host (SWA-56). */
  restoreWorkspace: (saved: SavedWorkspace, reattach?: (leaf: SavedLeaf) => ReattachLeaf | undefined) => void
  forgetWorkspace: (savedId: string) => void
  recordPaneSession: (terminalId: string, agentId: string, sessionId: string) => void
  setWelcomeFolder: (path: string) => void
  openWelcome: () => void
  focusWelcome: () => void
  closeWelcome: () => void
  setActiveWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  closeWorkspace: (id: string) => void
  moveWorkspace: (fromId: string, toId: string) => void
  setFocusedLeaf: (leafId: string) => void
  /** Jump to a terminal wherever it lives: activate its workspace AND focus
   *  its pane. No-op for unknown ids. (War Room click-to-navigate.) */
  revealTerminal: (terminalId: string) => void
  setDropTarget: (terminalId: string | null) => void
  /** `agentId` is the resolved split agent (lib/agent-pref resolveSplitAgent);
   *  absent or 'terminal' ⇒ a plain shell. */
  splitPane: (leafId: string, direction: Direction, agentId?: string) => void
  /** Account/agent handoff (SWA-22): split `leafId` into a new pane running
   *  `agentId` with `accountId` in `cwd`. The source pane is left untouched.
   *  No initialPrompt: the brief is delivered later, after confirmation.
   *  Returns the new terminalId, or undefined when the leaf is not found. */
  handoffPane: (leafId: string, target: { agentId: string; accountId?: string; cwd: string }) => string | undefined
  /** Prompt dispatch (SWA-23): split the active workspace's focused pane
   *  into a new `agentId` pane that starts with `prompt` as its start
   *  argument (the worker path), optionally inside a fresh worktree.
   *  Returns the new terminalId, or undefined without an active workspace. */
  promptPane: (target: { agentId: string; accountId?: string; prompt: string; worktree?: { path: string; branch: string } }) => string | undefined
  /** Set (or clear with undefined) a workspace's default split agent. */
  setWorkspaceDefaultAgent: (workspaceId: string, agentId: string | undefined) => void
  closePane: (leafId: string) => void
  toggleZoom: (leafId: string) => void
  /** Park a pane in its workspace's drawer: hidden like a close, but kept alive. */
  drawerPane: (leafId: string) => void
  /** Detach a pane from the split view into a floating window. */
  floatPane: (leafId: string) => void
  /** Return a floating pane to its original slot in the split view. */
  dockFloatingPane: (leafId: string) => void
  /** Move/resize a floating pane; also raises it to the top. */
  setFloatRect: (rect: FloatRect) => void
  /** Bring a drawered pane back into its original slot and focus it. */
  restorePane: (leafId: string) => void
  runFileInPane: (leafId: string, cwd: string, command: string) => void
  reorderPane: (fromLeafId: string, toLeafId: string) => void
  /** Drag-to-split: dock `fromLeafId` onto `side` of `toLeafId` (active workspace). */
  dockPane: (fromLeafId: string, toLeafId: string, side: DockSide) => void
  /** Snap layout: rebuild the active workspace as `presetId` with `leafId` in `slot`. */
  applySnapLayout: (leafId: string, presetId: string, slot: number) => void
  resizeSplitNode: (splitId: string, sizes: [number, number]) => void
  /** Even out one split (double-clicked separator); see `equalizeSplit` in lib/layout-tree. */
  equalizeSplitNode: (splitId: string) => void
  /** Even out a workspace's panes by geometry (see `tidyLayout` in lib/layout-tree). */
  tidyLayout: (workspaceId: string) => void
  setPaneAgent: (leafId: string, agentId: string) => void
  /** Respawn the pane under another profile. `keepSession`: the session was
   *  copied into that profile's store first, so resume it there. */
  setPaneAccount: (leafId: string, accountId?: string, keepSession?: boolean) => void
  setPaneCwd: (leafId: string, cwd: string | undefined) => void
  setPaneLaunchMode: (leafId: string, modeId: string) => void
  /** Pin the mode a pane spawned under without respawning it (no-op when set). */
  seedPaneLaunchMode: (leafId: string, modeId: string) => void
  pickPaneSession: (leafId: string) => void
  setPaneShell: (leafId: string, shellId: ShellId) => void
  /** Name a pane of the active workspace (BUZ-5); blank clears it. Never respawns. */
  renamePane: (leafId: string, name: string) => void
  spawnWorktreePane: (p: {
    requesterTerminalId: string
    path: string
    branch: string
    agentId?: string
    prompt: string
  }) => void
  clearWorktreeBinding: (path: string) => void
  clearWorktrees: (targets: ClearTarget[]) => Promise<void>
  toggleBroadcast: () => void
  toggleBroadcastMember: (leafId: string) => void
  selectAllBroadcast: () => void
  clearBroadcast: () => void
}

export type AppStore = AppState & AppActions

// --- pure helpers ---------------------------------------------------------

function uid(): string {
  return crypto.randomUUID()
}

/** Return `list` with the item at index `from` moved to index `to`. */
function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** A plain-shell leaf — no template command. Used when splitting a pane. */
function makeLeaf(): LeafNode {
  return { type: 'leaf', id: uid(), terminalId: uid() }
}

/** Compare paths ignoring separator style — Windows sources mix / and \. */
function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && a.replace(/\\/g, '/') === b.replace(/\\/g, '/')
}

/** Return the active workspace, or `undefined` if it cannot be resolved. */
export function selectActiveWorkspace(state: AppState): Workspace | undefined {
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId)
}

/** The workspace whose layout owns `terminalId`, or `undefined` if none. */
export function selectWorkspaceByTerminalId(
  state: AppState,
  terminalId: string
): Workspace | undefined {
  return state.workspaces.find((w) =>
    collectLeaves(w.layout).some((l) => l.terminalId === terminalId)
  )
}

/**
 * The terminal that should own the keyboard: the focused leaf of the active
 * workspace. `undefined` when no workspace exists (Welcome-only launch).
 */
export function selectFocusedTerminalId(state: AppState): string | undefined {
  const ws = selectActiveWorkspace(state)
  if (!ws) return undefined
  return focusedVisibleLeaf(ws)?.terminalId
}

/** Map the active workspace through `fn`, leaving the others untouched. */
function mapActive(state: AppState, fn: (w: Workspace) => Workspace): Pick<AppState, 'workspaces'> {
  return {
    workspaces: state.workspaces.map((w) => (w.id === state.activeWorkspaceId ? fn(w) : w))
  }
}

function removeWorkspace(s: AppState, id: string): Partial<AppState> {
  const index = s.workspaces.findIndex((w) => w.id === id)
  if (index === -1) return {}
  const remaining = s.workspaces.filter((w) => w.id !== id)
  if (!remaining.length) return { workspaces: [], activeWorkspaceId: '', welcomeOpen: true, welcomeFocused: true }
  return { workspaces: remaining, activeWorkspaceId: id === s.activeWorkspaceId ? remaining[Math.min(index, remaining.length - 1)].id : s.activeWorkspaceId }
}

// --- store ----------------------------------------------------------------

export const appStoreCreator: StateCreator<AppStore> = (set, get) => ({
  workspaces: [],
  activeWorkspaceId: '',
  nextWorkspaceNumber: 1,
  welcomeOpen: true,
  welcomeFocused: true,
  dropTargetTerminalId: null,
  welcomeFolder: '',

  createWorkspace: (config) =>
    set((s) => {
      // Pane count = squad size (one agent id per pane); paneLayoutFor derives
      // the grid/split shape. makeWizardLeaf is called row-major, matching the
      // agentIds order. The ?? fallback is defensive — agentIds.length panes
      // always have a matching id.
      let paneIndex = 0
      const resumePanes = config.resumePanes ?? []
      const makeWizardLeaf = (): LeafNode => {
        const i = paneIndex++
        // Leaves past the stepper count are resume panes: they spawn at the
        // session's recorded cwd and never get a worktree (the resume lookup
        // is cwd-scoped in every CLI).
        const resume = i >= config.terminalCount ? resumePanes[i - config.terminalCount] : undefined
        if (resume) {
          return {
            type: 'leaf',
            id: uid(),
            terminalId: uid(),
            agentId: resume.agentId,
            accountId: resume.accountId,
            resumeSessionId: resume.sessionId,
            sessionId: resume.sessionId,
            cwd: resume.cwd
          }
        }
        const wt = config.paneWorktrees?.[i] ?? null
        return {
          type: 'leaf',
          id: uid(),
          terminalId: uid(),
          agentId: config.agentIds[i] ?? DEFAULT_TEMPLATE_ID,
          accountId: config.accountIds?.[i],
          startupCommand: config.startupCommands?.[i],
          ...(wt ? { cwd: wt.path, worktreeBranch: wt.branch } : {})
        }
      }
      const layout = paneLayoutFor(config.terminalCount + resumePanes.length, makeWizardLeaf, uid)
      const ws: Workspace = {
        id: uid(),
        savedId: uid(),
        name: workspaceNameFor(
          config.cwd,
          s.workspaces.map((w) => w.name),
          s.nextWorkspaceNumber
        ),
        cwd: config.cwd,
        layout,
        focusedLeafId: collectLeaves(layout)[0].id,
        broadcastActive: false,
        broadcastLeafIds: [],
        worktreeMode: config.worktreeMode ?? false,
        ...(config.defaultAgentId ? { defaultAgentId: config.defaultAgentId } : {}),
        ...(config.accountSelections ? { accountSelections: config.accountSelections } : {})
      }
      return {
        workspaces: [...s.workspaces, ws],
        activeWorkspaceId: ws.id,
        nextWorkspaceNumber: s.nextWorkspaceNumber + 1,
        welcomeOpen: false,
        welcomeFocused: false
      }
    }),

  restoreWorkspace: (saved, reattach) => set((s) => {
    const open = s.workspaces.find(w => w.savedId === saved.id)
    if (open) return { activeWorkspaceId: open.id, welcomeFocused: false }
    const ws = fromSaved(saved, uid, reattach)
    return { workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id, welcomeFocused: false, welcomeOpen: false }
  }),

  forgetWorkspace: (savedId) => set((s) => ({ workspaces: s.workspaces.map(w => w.savedId === savedId ? { ...w, savedId: undefined } : w) })),

  recordPaneSession: (terminalId, agentId, sessionId) => set((s) => {
    if (!isValidSessionId(agentId, sessionId)) return s
    const ws = selectWorkspaceByTerminalId(s, terminalId)
    const leaf = ws && collectLeaves(ws.layout).find(l => l.terminalId === terminalId)
    if (!ws || !leaf || leaf.agentId !== agentId || leaf.sessionId === sessionId) return s
    return { workspaces: s.workspaces.map(w => w.id === ws.id ? { ...w, layout: updateLeaf(w.layout, leaf.id, { sessionId }) } : w) }
  }),

  setWelcomeFolder: (path) => set({ welcomeFolder: path }),

  openWelcome: () => set({ welcomeOpen: true, welcomeFocused: true }),

  focusWelcome: () => set({ welcomeFocused: true }),

  closeWelcome: () => set({ welcomeOpen: false, welcomeFocused: false }),

  setActiveWorkspace: (id) =>
    set((s) =>
      s.workspaces.some((w) => w.id === id)
        ? { activeWorkspaceId: id, welcomeFocused: false }
        : {}
    ),

  renameWorkspace: (id, name) =>
    set((s) => {
      const trimmed = name.trim()
      if (trimmed === '') return {}
      return {
        workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w))
      }
    }),

  closeWorkspace: (id) => {
    const ws = get().workspaces.find((w) => w.id === id)
    if (!ws) return
    withCloseGuard(collectLeaves(ws.layout).map((l) => l.id), () => set((s) => removeWorkspace(s, id)))
  },

  moveWorkspace: (fromId, toId) =>
    set((s) => {
      if (fromId === toId) return {}
      const from = s.workspaces.findIndex((w) => w.id === fromId)
      const to = s.workspaces.findIndex((w) => w.id === toId)
      if (from === -1 || to === -1) return {}
      return { workspaces: arrayMove(s.workspaces, from, to) }
    }),

  setFocusedLeaf: (leafId) =>
    set((s) => {
      const ws = selectActiveWorkspace(s)
      if (!ws || !findLeaf(ws.layout, leafId)) return s
      if (ws.focusedLeafId === leafId && !isDrawered(ws, leafId)) return s
      // Focusing a pane hidden behind a zoom or in the drawer must show it,
      // not type blind.
      return mapActive(s, (w) => focusLeaf(w, leafId))
    }),

  revealTerminal: (terminalId) =>
    set((s) => {
      const ws = selectWorkspaceByTerminalId(s, terminalId)
      if (!ws) return {}
      const leaf = collectLeaves(ws.layout).find((l) => l.terminalId === terminalId)
      if (!leaf) return {}
      return {
        activeWorkspaceId: ws.id,
        welcomeFocused: false,
        workspaces: s.workspaces.map((w) => (w.id === ws.id ? focusLeaf(w, leaf.id) : w))
      }
    }),

  setDropTarget: (terminalId) => set({ dropTargetTerminalId: terminalId }),

  splitPane: (leafId, direction, agentId) =>
    set((s) =>
      mapActive(s, (w) => {
        const source = findLeaf(w.layout, leafId)
        if (!source || isDrawered(w, leafId)) return w
        // Plain shells keep agentId absent (the layout-tree convention). The
        // split pane spawns at the workspace cwd, never in a fresh worktree:
        // a branch per click would litter <repo>.worktrees; agents that need
        // isolation mid-session use the worktree.spawn MCP tool instead.
        const newLeaf: LeafNode =
          agentId && agentId !== DEFAULT_TEMPLATE_ID ? { ...makeLeaf(), agentId } : makeLeaf()
        const accountId = splitAccountFor(newLeaf.agentId, newLeaf.agentId ? w.accountSelections?.[newLeaf.agentId] : undefined,
          useAgentAccountsStore.getState().accounts, collectLeaves(w.layout), source)
        if (accountId) newLeaf.accountId = accountId
        return {
          ...w,
          layout: splitLeaf(w.layout, leafId, direction, newLeaf, uid()),
          focusedLeafId: newLeaf.id,
          // The new pane must be visible, so a split always ends the zoom.
          zoomedLeafId: undefined
        }
      })
    ),

  handoffPane: (leafId, target) => {
    let terminalId: string | undefined
    set((s) =>
      mapActive(s, (w) => {
        if (!findLeaf(w.layout, leafId) || isDrawered(w, leafId)) return w
        const newLeaf: LeafNode = { ...makeLeaf(), agentId: target.agentId, accountId: target.accountId, cwd: target.cwd }
        terminalId = newLeaf.terminalId
        return {
          ...w,
          layout: splitLeaf(w.layout, leafId, 'horizontal', newLeaf, uid()),
          focusedLeafId: newLeaf.id,
          zoomedLeafId: undefined
        }
      })
    )
    return terminalId
  },

  promptPane: (target) => {
    let terminalId: string | undefined
    set((s) =>
      mapActive(s, (w) => {
        const anchor =
          findLeaf(w.layout, w.focusedLeafId) && !isDrawered(w, w.focusedLeafId)
            ? w.focusedLeafId
            : collectLeaves(w.layout).find((l) => !isDrawered(w, l.id))?.id
        if (!anchor) return w
        const newLeaf: LeafNode = {
          ...makeLeaf(),
          agentId: target.agentId,
          accountId: target.accountId,
          initialPrompt: target.prompt,
          ...(target.worktree ? { cwd: target.worktree.path, worktreeBranch: target.worktree.branch } : {})
        }
        terminalId = newLeaf.terminalId
        return {
          ...w,
          layout: splitLeaf(w.layout, anchor, 'horizontal', newLeaf, uid()),
          focusedLeafId: newLeaf.id,
          zoomedLeafId: undefined
        }
      })
    )
    return terminalId
  },

  setWorkspaceDefaultAgent: (workspaceId, agentId) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        if (agentId !== undefined) return { ...w, defaultAgentId: agentId }
        const rest = { ...w }
        delete rest.defaultAgentId
        return rest
      })
    })),

  runFileInPane: (leafId, cwd, command) => set((s) => {
    const ws = s.workspaces.find((w) => findLeaf(w.layout, leafId))
    if (!ws) return {}
    const source = findLeaf(ws.layout, leafId)!
    const runner: LeafNode = { ...makeLeaf(), cwd, shellId: source.shellId, startupCommand: command }
    return { activeWorkspaceId: ws.id, workspaces: s.workspaces.map((w) => w.id === ws.id ? { ...w, layout: splitLeaf(w.layout, leafId, 'horizontal', runner, uid()), focusedLeafId: runner.id, zoomedLeafId: undefined } : w) }
  }),

  toggleZoom: (leafId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => findLeaf(w.layout, leafId))
      if (!ws || isDrawered(ws, leafId) || isFloating(ws.floating, leafId)) return {}
      return { workspaces: s.workspaces.map((w) => w.id === ws.id ? { ...w, zoomedLeafId: toggledZoom(w.zoomedLeafId, leafId), focusedLeafId: leafId } : w) }
    }),

  drawerPane: (leafId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => findLeaf(w.layout, leafId))
      if (!ws || isDrawered(ws, leafId)) return {}
      const drawerLeafIds = [...(ws.drawerLeafIds ?? []), leafId]
      // Focus moves on like a close would; with nothing left on screen it stays
      // on the drawered leaf (the workspace shows its empty state) so the
      // invariant "focusedLeafId is a leaf of layout" still holds.
      const focusedLeafId = ws.focusedLeafId === leafId
        ? nextVisibleLeafId(ws.layout, drawerLeafIds, leafId) ?? leafId
        : ws.focusedLeafId
      return { workspaces: s.workspaces.map((w) => w.id !== ws.id ? w : {
        ...w,
        drawerLeafIds,
        focusedLeafId,
        floating: w.floating && unfloatPane(w.floating, leafId),
        // A zoom on the parked pane lapses; a zoom on another pane survives.
        zoomedLeafId: w.zoomedLeafId === leafId ? undefined : w.zoomedLeafId,
        // Keystrokes must never fan out into a pane nobody can see.
        broadcastLeafIds: w.broadcastLeafIds.filter((id) => id !== leafId)
      }) }
    }),

  floatPane: (leafId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => findLeaf(w.layout, leafId))
      if (!ws || isDrawered(ws, leafId)) return {}
      return { workspaces: s.workspaces.map((w) => w.id !== ws.id ? w : {
        ...w,
        floating: floatPane(w.floating ?? [], leafId),
        focusedLeafId: leafId,
        // A zoom would hide the split view the float was just lifted from.
        zoomedLeafId: undefined
      }) }
    }),

  dockFloatingPane: (leafId) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => isFloating(w.floating, leafId)
      ? { ...w, floating: unfloatPane(w.floating!, leafId), focusedLeafId: leafId }
      : w) })),

  setFloatRect: (rect) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => isFloating(w.floating, rect.leafId)
      ? { ...w, floating: [...unfloatPane(w.floating!, rect.leafId), clampFloatRect(rect)] }
      : w) })),

  restorePane: (leafId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => findLeaf(w.layout, leafId))
      if (!ws || !isDrawered(ws, leafId)) return {}
      return {
        activeWorkspaceId: ws.id,
        welcomeFocused: false,
        workspaces: s.workspaces.map((w) => (w.id === ws.id ? focusLeaf(w, leafId) : w))
      }
    }),

  closePane: (leafId) => {
    const owner = get().workspaces.find((w) => findLeaf(w.layout, leafId))
    if (!owner) return
    withCloseGuard([leafId], () => {
      const ws = get().workspaces.find((w) => w.id === owner.id)
      if (!ws || !findLeaf(ws.layout, leafId)) return
      const layout = closeLeaf(ws.layout, leafId)
      if (layout === null) { set((s) => removeWorkspace(s, ws.id)); return }
      set((s) => ({ workspaces: s.workspaces.map((w) => {
        if (w.id !== ws.id) return w
        const leaves = collectLeaves(layout)
        const ids = new Set(leaves.map((l) => l.id))
        const drawerLeafIds = drawerAfterRemoval(w.drawerLeafIds ?? [], layout)
        // Prefer a pane still on screen; fall back to a drawered one only when
        // every survivor is parked (the workspace then shows its empty state).
        const fallback = leaves.find((l) => !drawerLeafIds.includes(l.id)) ?? leaves[0]
        const floating = w.floating && floatingAfterRemoval(w.floating, layout)
        return { ...w, layout, drawerLeafIds, floating, focusedLeafId: ids.has(w.focusedLeafId) ? w.focusedLeafId : fallback.id,
          broadcastLeafIds: w.broadcastLeafIds.filter((id) => ids.has(id)) }
      }) }))
    })
  },

  // Reorder panes in the active workspace: move `fromLeafId` to `toLeafId`'s
  // slot, reflowing the rest. reorderLeaves moves whole leaf nodes, so
  // focusedLeafId and broadcastLeafIds (which point at leaf ids) stay valid and
  // follow the terminals — no extra bookkeeping needed.
  reorderPane: (fromLeafId, toLeafId) =>
    set((s) =>
      mapActive(s, (w) => {
        if (fromLeafId === toLeafId) return w
        if (!findLeaf(w.layout, fromLeafId) || !findLeaf(w.layout, toLeafId)) return w
        // Dropping a floating pane onto a docked one docks it in that slot.
        if (isFloating(w.floating, toLeafId)) return w
        return { ...w, layout: reorderLeaves(w.layout, fromLeafId, toLeafId),
          floating: w.floating && unfloatPane(w.floating, fromLeafId) }
      })
    ),

  // Both layout drags move whole leaf nodes (like reorderPane), so focus,
  // broadcast and drawer ids stay valid. Each ends the zoom — the user just
  // arranged several panes and must see the result — and focuses the dragged
  // pane. Drawered panes cannot be dragged (they are not on screen); the guard
  // only protects against a stale drag landing after a drawer action.
  dockPane: (fromLeafId, toLeafId, side) =>
    set((s) =>
      mapActive(s, (w) => {
        if (isDrawered(w, fromLeafId) || isDrawered(w, toLeafId)) return w
        // Targets are docked panes only: a floating target has no visible slot.
        if (isFloating(w.floating, toLeafId)) return w
        const layout = moveLeafBeside(w.layout, fromLeafId, toLeafId, side, uid())
        if (layout === w.layout) return w
        return { ...w, layout, focusedLeafId: fromLeafId, zoomedLeafId: undefined,
          floating: w.floating && unfloatPane(w.floating, fromLeafId) }
      })
    ),

  applySnapLayout: (leafId, presetId, slot) =>
    set((s) =>
      mapActive(s, (w) => {
        const layout = applyPreset(w.layout, w.drawerLeafIds ?? [], presetId, leafId, slot, uid)
        if (layout === null) return w
        // The preset arranges every non-drawered pane, floating ones included.
        return { ...w, layout, focusedLeafId: leafId, zoomedLeafId: undefined, floating: undefined }
      })
    ),

  resizeSplitNode: (splitId, sizes) =>
    set((s) => mapActive(s, (w) => ({ ...w, layout: resizeSplit(w.layout, splitId, sizes) }))),

  // Drawered and floating panes take no room on screen, so they stay out of
  // the count, as in tidyLayout.
  equalizeSplitNode: (splitId) =>
    set((s) =>
      mapActive(s, (w) => {
        const layout = equalizeSplit(w.layout, splitId, hiddenLeafIds(w.drawerLeafIds ?? [], w.floating ?? []))
        return layout === w.layout ? w : { ...w, layout }
      })
    ),

  // Takes the workspace id rather than acting on the active one, so the sidebar
  // menu can tidy any workspace without switching to it. Drawered and floating
  // panes take no room in the split view, so they stay out of the maths. A zoom
  // ends: the user asked to see an even layout, and a zoomed pane would hide it.
  tidyLayout: (workspaceId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === workspaceId)
      if (!ws) return {}
      const layout = tidyLayout(ws.layout, hiddenLeafIds(ws.drawerLeafIds ?? [], ws.floating ?? []))
      if (layout === ws.layout && ws.zoomedLeafId === undefined) return {}
      return { workspaces: s.workspaces.map((w) => (w.id === ws.id ? { ...w, layout, zoomedLeafId: undefined } : w)) }
    }),

  // An agent switch respawns the pty; replaying a brief written for another
  // agent would be wrong, so a pending prompt is dropped along with it. A
  // resume session id is meaningless under another agent too — clear it.
  // Without `keepSession` the other profile's store has no copy of the
  // conversation, so the pane starts fresh there.
  setPaneAccount: (leafId, accountId, keepSession) => set(s => mapActive(s, w => {
    const leaf = findLeaf(w.layout, leafId)
    if (!leaf || leaf.accountId === accountId) return w
    const resumeSessionId = keepSession ? leaf.sessionId ?? leaf.resumeSessionId : undefined
    return { ...w, layout: updateLeaf(w.layout, leafId, { accountId, resumeSessionId, sessionId: undefined, continueSession: undefined, initialPrompt: undefined, startupCommand: undefined }) }
  })),

  // Agent changes also clear profile-specific login commands and conversations.
  setPaneAgent: (leafId, agentId) =>
    set((s) =>
      mapActive(s, (w) => ({
        ...w,
        layout: updateLeaf(w.layout, leafId, {
          agentId,
          accountId: undefined,
          startupCommand: undefined,
          initialPrompt: undefined,
          resumeSessionId: undefined,
          sessionId: undefined,
          launchMode: undefined,
          continueSession: undefined
        })
      }))
    ),

  // A mode switch respawns the pty with the new launch args and keeps the
  // conversation: an explicit resume id carries over, otherwise the pane
  // continues its latest session. A pending brief must not run twice.
  setPaneLaunchMode: (leafId, modeId) =>
    set((s) =>
      mapActive(s, (w) => {
        const leaf = findLeaf(w.layout, leafId)
        return {
          ...w,
          layout: updateLeaf(w.layout, leafId, {
            launchMode: modeId,
            initialPrompt: undefined,
            resumeSessionId: leaf?.sessionId ?? leaf?.resumeSessionId,
            continueSession: (leaf?.sessionId ?? leaf?.resumeSessionId) === undefined ? 'last' : undefined
          })
        }
      })
    ),

  // Records the Settings default a pane first spawned under, so a later
  // Settings change never alters (or respawns) a running pane. The command
  // string is unchanged by this, hence no respawn. Leaves may sit in any
  // workspace, not just the active one.
  seedPaneLaunchMode: (leafId, modeId) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        const leaf = findLeaf(w.layout, leafId)
        if (leaf == null || leaf.launchMode !== undefined) return w
        return { ...w, layout: updateLeaf(w.layout, leafId, { launchMode: modeId }) }
      })
    })),

  // Respawn into the CLI's own session picker (current launch mode kept), so
  // an older chat can be taken over in this pane.
  pickPaneSession: (leafId) =>
    set((s) =>
      mapActive(s, (w) => ({
        ...w,
        layout: updateLeaf(w.layout, leafId, {
          continueSession: 'pick',
          resumeSessionId: undefined,
          sessionId: undefined,
          initialPrompt: undefined
        })
      }))
    ),

  // Re-pointing a pane's folder must drop any stale worktree binding — otherwise
  // the header keeps showing the old branch chip and a later "Clear worktree"
  // would target a path the pane no longer runs in. Matches clearWorktreeBinding's
  // patch shape (also drops a stale initialPrompt written for the old folder, and
  // resumeSessionId — a session can't be found from a different cwd).
  setPaneCwd: (leafId, cwd) =>
    set((s) =>
      mapActive(s, (w) => ({
        ...w,
        layout: updateLeaf(w.layout, leafId, {
          cwd,
          worktreeBranch: undefined,
          initialPrompt: undefined,
          resumeSessionId: undefined,
          sessionId: undefined,
          continueSession: undefined
        })
      }))
    ),

  setPaneShell: (leafId, shellId) =>
    set((s) => mapActive(s, (w) => ({ ...w, layout: updateLeaf(w.layout, leafId, { shellId }) }))),

  renamePane: (leafId, name) =>
    set((s) => mapActive(s, (w) => ({ ...w, layout: updateLeaf(w.layout, leafId, { name: sanitizePaneName(name) }) }))),

  // Worker panes are spawned by the backend's worktree.spawn MCP tool: split
  // the *requester's* leaf (which may live in a non-active workspace, so this
  // deliberately avoids mapActive) and let the normal pane-mount path spawn
  // the pty inside the worktree with the task brief.
  spawnWorktreePane: (p) =>
    set((s) => {
      const ws = selectWorkspaceByTerminalId(s, p.requesterTerminalId)
      if (!ws || !ws.worktreeMode) return {}
      const requester = collectLeaves(ws.layout).find(
        (l) => l.terminalId === p.requesterTerminalId
      )
      if (!requester) return {}
      // Fall back to the requester's agent; a plain-shell requester yields a
      // plain shell in the worktree — visible, never a silent drop.
      const agentId = p.agentId ?? requester.agentId
      const newLeaf: LeafNode = {
        type: 'leaf',
        id: uid(),
        terminalId: uid(),
        agentId,
        // A same-CLI worker shares the caller's profile, never its conversation.
        // Profiles from a different CLI cannot authenticate the requested agent.
        accountId: agentId === requester.agentId ? requester.accountId : undefined,
        cwd: p.path,
        worktreeBranch: p.branch,
        initialPrompt: p.prompt,
        // A worker runs unattended: inherit the requester's mode (same agent
        // only — mode ids are per-agent) so a bypassed orchestrator doesn't
        // spawn workers that stall on the first permission prompt.
        ...(agentId === requester.agentId && requester.launchMode !== undefined
          ? { launchMode: requester.launchMode }
          : {})
      }
      return {
        workspaces: s.workspaces.map((w) =>
          w.id === ws.id
            ? {
                ...w,
                layout: splitLeaf(w.layout, requester.id, 'horizontal', newLeaf, uid()),
                focusedLeafId: newLeaf.id
              }
            : w
        )
      }
    }),

  clearWorktreeBinding: (path) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        const bound = collectLeaves(w.layout).filter((l) => samePath(l.cwd, path))
        if (bound.length === 0) return w
        let layout = w.layout
        for (const leaf of bound) {
          // The worktree directory is gone after worktree.remove, so leaving
          // cwd/initialPrompt pointed at it would respawn into a dead path (or
          // replay the original prompt) next time the pane's pty restarts.
          // Clearing cwd lets TerminalPane's existing respawn effect relocate
          // the pane back to the workspace folder, same as any other pane.
          layout = updateLeaf(layout, leaf.id, {
            worktreeBranch: undefined,
            cwd: undefined,
            initialPrompt: undefined,
            resumeSessionId: undefined,
            sessionId: undefined,
            continueSession: undefined
          })
        }
        return { ...w, layout }
      })
    })),

  clearWorktrees: async (targets) => {
    const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    for (const t of targets) {
      // Relocate the pane home — its respawn kills the pty holding the worktree
      // cwd lock and restarts a shell at the repo root.
      get().clearWorktreeBinding(t.path)
      // Wait for that relocation to complete (old pty dead) BEFORE deleting the
      // directory: deleting under a live pty guts the dir then fails rmdir on
      // Windows, leaving a husk. Timeout-backstopped inside the helper.
      await awaitTerminalRelocated(t.terminalId)
      for (let attempt = 0; ; attempt++) {
        try {
          await clearWorktree(t.repoRoot, t.path, t.branch)
          break
        } catch (e) {
          const msg = String(e)
          if (attempt < 5 && isTransientLock(msg)) {
            await delay(150)
            continue
          }
          console.warn(`clear worktree failed for ${t.branch}:`, msg)
          break
        }
      }
    }
  },

  toggleBroadcast: () =>
    set((s) =>
      mapActive(s, (w) => {
        const active = !w.broadcastActive
        return {
          ...w,
          broadcastActive: active,
          // Turning on selects every pane (the common "drive all" case); the
          // user narrows from there. Turning off clears the group.
          broadcastLeafIds: active ? visibleLeaves(w).map((l) => l.id) : []
        }
      })
    ),

  // Group membership can be edited even while broadcast is off; turning it on
  // via toggleBroadcast re-selects all panes, so off-mode edits are harmless.
  toggleBroadcastMember: (leafId) =>
    set((s) =>
      mapActive(s, (w) => {
        if (!findLeaf(w.layout, leafId) || isDrawered(w, leafId)) return w
        const has = w.broadcastLeafIds.includes(leafId)
        return {
          ...w,
          broadcastLeafIds: has
            ? w.broadcastLeafIds.filter((id) => id !== leafId)
            : [...w.broadcastLeafIds, leafId]
        }
      })
    ),

  selectAllBroadcast: () =>
    set((s) =>
      mapActive(s, (w) => ({ ...w, broadcastLeafIds: visibleLeaves(w).map((l) => l.id) }))
    ),

  clearBroadcast: () => set((s) => mapActive(s, (w) => ({ ...w, broadcastLeafIds: [] })))
})

export const useAppStore = create<AppStore>()(appStoreCreator)

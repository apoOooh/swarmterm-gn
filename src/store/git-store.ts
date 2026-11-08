// src/store/git-store.ts
import { create } from 'zustand'
import {
  listWorktrees,
  getChangedFiles,
  getFileDiff,
  getCommitInfo,
  mergeReadiness,
  type WorktreeInfo,
  type ChangedFile,
  type CommitInfo,
  type MergeReadiness,
} from '@/tauri/git'
import { matchWorktreeForCwd } from '@/lib/worktree-match'

export type RightPanelMode = 'browser' | 'git' | 'warroom' | 'media'

export type { WorktreeInfo, ChangedFile, CommitInfo, MergeReadiness }

interface GitStore {
  panelOpen: boolean
  mode: RightPanelMode
  currentCwd: string
  worktrees: WorktreeInfo[]
  selectedWorktreePath: string
  /** Changed-file count per worktree path. Undefined while still loading that worktree. */
  worktreeCounts: Map<string, number>
  changedFiles: ChangedFile[]
  commitInfo: CommitInfo | null
  /** Null for the main worktree (never probed) and on any probe error (fail-open: no footer line). */
  mergeReadiness: MergeReadiness | null
  expandedFiles: Set<string>
  fileDiffs: Map<string, string>
  loading: boolean
  error: string | null

  setMode: (mode: RightPanelMode) => void
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  selectWorktree: (path: string) => void
  toggleFileExpand: (filePath: string) => void
  fetchWorktrees: (cwd: string) => Promise<void>
  fetchFileDiff: (filePath: string) => Promise<void>
  /** Manual re-list (the panel's Refresh button): re-runs fetchWorktrees, so new worktrees appear and the cwd auto-select runs again. */
  refresh: () => void
  /**
   * Re-fetch the CURRENT selection in place: files, commit info, this
   * worktree's count and the merge probe. Unlike fetchWorktrees it never
   * resets state or re-runs the cwd auto-select, so a manual pick and the
   * on-screen list survive. Driven by lib/git-refresh.
   */
  refreshSelected: () => void
}

export const useGitStore = create<GitStore>((set, get) => {
  // Merge probe rides its own promise: `git merge-tree` can be slower than the
  // file list and must never delay it. Main worktree ⇒ never asked (self-merge).
  // Passing the worktree path as repoRoot is fine — the Rust side resolves the
  // main root through `--git-common-dir`, so the probe still runs at main's HEAD.
  // A failed probe CLEARS the verdict instead of leaving it: after a refresh a
  // stale line would claim a merge status from before the agent's commits.
  const probeMergeReadiness = (path: string): void => {
    const wt = get().worktrees.find((t) => t.path === path)
    if (!wt || wt.isMain || wt.branch === '(detached)') return
    void mergeReadiness(path, wt.branch)
      .then((r) => {
        if (get().selectedWorktreePath === path) set({ mergeReadiness: r })
      })
      .catch(() => {
        if (get().selectedWorktreePath === path) set({ mergeReadiness: null })
      })
  }

  return {
    panelOpen: false,
    mode: 'browser',
    currentCwd: '',
    worktrees: [],
    selectedWorktreePath: '',
    worktreeCounts: new Map(),
    changedFiles: [],
    commitInfo: null,
    mergeReadiness: null,
    expandedFiles: new Set(),
    fileDiffs: new Map(),
    loading: false,
    error: null,

    setMode: (mode) => {
      // Picking a tab always reveals the panel (the tabs live inside it).
      set({ mode, panelOpen: true })
      if (mode === 'git') {
        const { currentCwd } = get()
        if (currentCwd) void get().fetchWorktrees(currentCwd)
      }
    },

    setPanelOpen: (open) => set({ panelOpen: open }),

    togglePanel: () => {
      const open = !get().panelOpen
      set({ panelOpen: open })
      // Opening into Git mode triggers a fresh fetch for the focused terminal.
      if (open && get().mode === 'git') {
        const { currentCwd } = get()
        if (currentCwd) void get().fetchWorktrees(currentCwd)
      }
    },

    selectWorktree: (path) => {
      set({
        selectedWorktreePath: path,
        changedFiles: [],
        commitInfo: null,
        mergeReadiness: null,
        expandedFiles: new Set(),
        fileDiffs: new Map(),
        loading: true,
        error: null,
      })
      void (async () => {
        try {
          const [files, info] = await Promise.all([
            getChangedFiles(path),
            getCommitInfo(path),
          ])
          if (get().selectedWorktreePath !== path) return  // selection changed — discard stale results
          set({ changedFiles: files, commitInfo: info, loading: false })
        } catch (e) {
          set({ error: String(e), loading: false })
        }
      })()
      probeMergeReadiness(path)
    },

    refreshSelected: () => {
      const path = get().selectedWorktreePath
      if (!path) return
      void (async () => {
        try {
          const [files, info] = await Promise.all([
            getChangedFiles(path),
            getCommitInfo(path),
          ])
          if (get().selectedWorktreePath !== path) return  // selection changed — discard stale results
          const alive = new Set(files.map((f) => f.path))
          const expanded = new Set([...get().expandedFiles].filter((p) => alive.has(p)))
          // Old diffs of surviving rows stay until their re-fetch lands: nothing
          // is reset up front because this runs under the user's eyes, and an
          // empty list per agent transition would read as the panel breaking.
          const diffs = new Map([...get().fileDiffs].filter(([p]) => alive.has(p)))
          const counts = new Map(get().worktreeCounts)
          counts.set(path, files.length)
          set({
            changedFiles: files,
            commitInfo: info,
            expandedFiles: expanded,
            fileDiffs: diffs,
            worktreeCounts: counts,
            error: null,
          })
          for (const p of expanded) void get().fetchFileDiff(p)
        } catch (e) {
          set({ error: String(e) })
        }
      })()
      probeMergeReadiness(path)
    },

    toggleFileExpand: (filePath) => {
      const { expandedFiles } = get()
      const next = new Set(expandedFiles)
      if (next.has(filePath)) {
        next.delete(filePath)
        set({ expandedFiles: next })
      } else {
        next.add(filePath)
        set({ expandedFiles: next })
        if (!get().fileDiffs.has(filePath)) {
          void get().fetchFileDiff(filePath)
        }
      }
    },

    fetchWorktrees: async (cwd) => {
      set({
        loading: true,
        error: null,
        currentCwd: cwd,
        worktrees: [],
        worktreeCounts: new Map(),
        changedFiles: [],
        commitInfo: null,
        mergeReadiness: null,
        expandedFiles: new Set(),
        fileDiffs: new Map(),
      })
      try {
        const trees = await listWorktrees(cwd)
        if (get().currentCwd !== cwd) return  // another fetch started — discard stale results
        if (trees.length === 0) {
          set({ worktrees: [], loading: false })
          return
        }
        // Auto-select the worktree that owns cwd. Not a bare startsWith: git lists
        // main first and `<repo>.worktrees/<slug>` begins with `<repo>`, so agent
        // panes used to land on main (and Windows `C:\` vs `C:/` never matched).
        const match = matchWorktreeForCwd(trees, cwd) ?? trees[0]
        set({ worktrees: trees, loading: false })
        get().selectWorktree(match.path)
        // Fill per-worktree change counts in parallel (best-effort, non-blocking).
        // Each result is merged as it arrives so the list updates progressively.
        for (const wt of trees) {
          void getChangedFiles(wt.path)
            .then((files) => {
              if (get().currentCwd !== cwd) return  // stale — a newer fetch is in flight
              const next = new Map(get().worktreeCounts)
              next.set(wt.path, files.length)
              set({ worktreeCounts: next })
            })
            .catch(() => { /* leave count undefined on failure */ })
        }
      } catch (e) {
        set({ error: String(e), loading: false })
      }
    },

    fetchFileDiff: async (filePath) => {
      const { selectedWorktreePath } = get()
      if (!selectedWorktreePath) return
      try {
        const diff = await getFileDiff(selectedWorktreePath, filePath)
        // Read the map AFTER the await: several rows re-fetch in parallel after
        // a refresh, and a Map captured before it would drop every sibling that
        // landed in the meantime. A diff for a previous selection is dropped —
        // the same file name in the new worktree would show the wrong content.
        if (get().selectedWorktreePath !== selectedWorktreePath) return
        const next = new Map(get().fileDiffs)
        next.set(filePath, diff)
        set({ fileDiffs: next })
      } catch {
        // Silently ignore — InlineDiff renders "No diff available" for empty string.
      }
    },

    refresh: () => {
      const { currentCwd } = get()
      if (currentCwd) void get().fetchWorktrees(currentCwd)
    },
  }
})

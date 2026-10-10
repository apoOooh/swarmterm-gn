// src/components/Git/GitPanel.tsx
import { useEffect, useMemo, type ReactElement } from 'react'
import { useAppStore, selectActiveWorkspace, focusedVisibleLeaf } from '@/store/app-store'
import { collectLeaves } from '@/lib/layout-tree'
import { useGitStore } from '@/store/git-store'
import { cn } from '@/lib/utils'
import {
  formatMergeReadiness,
  mergeReadinessTitle,
  mergeReadinessTone,
  mainBranchOf,
  type MergeTone,
} from '@/lib/merge-readiness'
import { WorktreeSelector } from './WorktreeSelector'
import { ChangedFileList } from './ChangedFileList'

// Same green/amber the changed-file list uses for M/A statuses — one palette
// across the panel, so "clean" and "conflicts" read like the statuses above.
const TONE_CLASS: Record<MergeTone, string> = {
  ok: 'text-[#4ec994]',
  warn: 'text-[#e2c08d]',
  muted: 'text-muted-foreground',
}

export function GitPanel(): ReactElement {
  const loading = useGitStore((s) => s.loading)
  const error = useGitStore((s) => s.error)
  const worktrees = useGitStore((s) => s.worktrees)
  const currentCwd = useGitStore((s) => s.currentCwd)
  const commitInfo = useGitStore((s) => s.commitInfo)
  const mergeReadiness = useGitStore((s) => s.mergeReadiness)
  const fetchWorktrees = useGitStore((s) => s.fetchWorktrees)
  // Derived from the worktree list already in the store (no extra git call);
  // only meaningful while a non-main worktree is selected, which is exactly
  // when the store leaves `mergeReadiness` non-null.
  const mainBranch = mainBranchOf(worktrees)

  // Branch -> agent id for the panes currently bound to a worktree, so the
  // selector can show which agent owns each worktree. Computed with useMemo
  // over the raw `workspaces` array (not a store selector) — a selector that
  // builds a fresh object every call would re-render this component forever.
  const workspaces = useAppStore((s) => s.workspaces)
  const agentByBranch = useMemo(() => {
    const map: Record<string, string> = {}
    for (const w of workspaces)
      for (const l of collectLeaves(w.layout))
        if (l.worktreeBranch && l.agentId) map[l.worktreeBranch] = l.agentId
    return map
  }, [workspaces])

  // Subscribe to the focused terminal's CWD and re-fetch when it changes.
  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state) => {
      const ws = selectActiveWorkspace(state)
      if (!ws) return
      const leaf = focusedVisibleLeaf(ws)
      const cwd = leaf?.cwd ?? ws.cwd
      if (!cwd) return
      if (cwd !== useGitStore.getState().currentCwd) {
        void fetchWorktrees(cwd)
      }
    })
    // Initial fetch on mount.
    const ws = selectActiveWorkspace(useAppStore.getState())
    if (ws) {
      const leaf = focusedVisibleLeaf(ws)
      const cwd = leaf?.cwd ?? ws.cwd
      if (cwd) void fetchWorktrees(cwd)
    }
    return unsubscribe
  }, [fetchWorktrees])

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <WorktreeSelector agentByBranch={agentByBranch} />

      {loading && (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
          {error}
        </div>
      )}

      {/* `currentCwd` is empty only before the first fetch — gate on it so the
          panel doesn't flash "Not a git repository" for one frame on mount
          (initial state is loading:false, worktrees:[]) before the effect runs. */}
      {!loading && !error && currentCwd !== '' && worktrees.length === 0 && (
        <div className="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
          Not a git repository
        </div>
      )}

      {!loading && !error && worktrees.length > 0 && <ChangedFileList />}

      {commitInfo && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
          {commitInfo.ahead != null && (
            <span>
              <span className="text-[#4ec994]">↑{commitInfo.ahead}</span>
              {' · '}
              <span>↓{commitInfo.behind ?? 0}</span>
            </span>
          )}
          {commitInfo.headSha && (
            <span className="ml-auto font-mono">HEAD: {commitInfo.headSha}</span>
          )}
        </div>
      )}

      {/* Absent for the main worktree by construction (the store never probes
          it) and on any probe failure (fail-open null) — never a stale verdict. */}
      {mergeReadiness && (
        <div
          className={cn(
            'shrink-0 border-t border-border bg-muted/30 px-2 py-1 text-[10px]',
            TONE_CLASS[mergeReadinessTone(mergeReadiness)],
          )}
          title={mergeReadinessTitle(mergeReadiness, mainBranch)}
        >
          {formatMergeReadiness(mergeReadiness, mainBranch)}
        </div>
      )}
    </div>
  )
}

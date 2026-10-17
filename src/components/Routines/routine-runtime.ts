import { useEffect } from 'react'
import { ROUTINE_TICK_MS, tickRoutines, type RoutineDeps } from '@/lib/routine-scheduler'
import { planWorktreeBranches, provisionWorktrees } from '@/lib/worktree-naming'
import { getTerminalStatus } from '@/lib/terminal-registry'
import { createWorktree } from '@/tauri/git'
import { runRoutineCommand } from '@/tauri/routines'
import { DEFAULT_TIMEOUT_MINUTES } from '@/lib/routines'
import { useAgentStateStore } from '@/store/agent-state-store'
import { useAppStore } from '@/store/app-store'
import { useNotificationCenterStore } from '@/store/notification-center-store'
import { useRoutineStore } from '@/store/routine-store'

/**
 * The app side of routines: how a run starts a pane and where outcomes go.
 * A run opens a new pane next to the focused one in the ACTIVE workspace,
 * exactly like the prompt library's "new pane" — routines have no workspace
 * of their own, so with only the home screen open a run reports and skips.
 */
export const routineDeps: RoutineDeps = {
  isBusy: (terminalId) => {
    if (!terminalId || getTerminalStatus(terminalId).kind !== 'running') return false
    const state = useAgentStateStore.getState().byId[terminalId]?.state
    return state === 'working' || state === 'blocked'
  },
  start: async (r) => {
    const st = useAppStore.getState()
    const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)
    if (!ws) return { error: 'no open workspace' }
    let worktree: { path: string; branch: string } | undefined
    if (r.worktree) {
      const [made] = await provisionWorktrees(planWorktreeBranches([r.agentId]), (name) => createWorktree(ws.cwd, name))
      // Isolation was asked for: never fall back to the main checkout silently.
      if (!made) return { error: 'could not create a git worktree' }
      worktree = made
    }
    const terminalId = useAppStore.getState().promptPane({ agentId: r.agentId, accountId: r.accountId, prompt: r.brief, worktree })
    return terminalId === undefined ? { error: 'no pane to split in the active workspace' } : { terminalId, branch: worktree?.branch }
  },
  runCommand: (r) => runRoutineCommand(r.command ?? '', r.cwd ?? '', (r.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60),
  patch: (id, change) => useRoutineStore.getState().patch(id, change),
  notify: (terminalId, title, detail) =>
    useNotificationCenterStore.getState().add({ kind: 'routine', terminalId, title, detail, at: Date.now() })
}

/** Ticks while the app runs; also right after hydrate and when the window regains focus (after sleep). */
export function useRoutineScheduler(): void {
  useEffect(() => {
    useRoutineStore.getState().hydrate()
    const tick = (): void => void tickRoutines(useRoutineStore.getState().routines, Date.now(), routineDeps)
    tick()
    const timer = window.setInterval(tick, ROUTINE_TICK_MS)
    window.addEventListener('focus', tick)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', tick)
    }
  }, [])
}

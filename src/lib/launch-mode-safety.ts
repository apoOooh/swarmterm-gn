import { TEMPLATES, launchMode } from '@/lib/templates'
import type { LaunchModePrefs } from '@/lib/agent-pref'

/**
 * Rules for the launch modes that switch an agent's own safety net off
 * (Claude "Bypass permissions", Codex "YOLO"). They stay available, but only
 * as a deliberate user choice for one pane: never inherited by agent-spawned
 * workers, always confirmed, always visible.
 */

/** Exact lookup: an unknown id is not dangerous (it resolves to the template
 *  default, which never is). */
export function isDangerousLaunchMode(agentId: string | undefined, modeId: string | undefined): boolean {
  if (agentId === undefined) return false
  return TEMPLATES.find((t) => t.id === agentId)?.launchModes?.find((m) => m.id === modeId)?.dangerous === true
}

export interface DangerousModeWarning {
  title: string
  body: string
}

/** Confirmation text for selecting a dangerous mode; undefined for safe ones. */
export function dangerousModeWarning(agentId: string, modeId: string): DangerousModeWarning | undefined {
  if (!isDangerousLaunchMode(agentId, modeId)) return undefined
  const mode = launchMode(agentId, modeId)!
  const agent = TEMPLATES.find((t) => t.id === agentId)!
  return {
    title: `Start ${agent.name} in "${mode.label}"?`,
    body:
      `In this mode ${agent.name} runs commands and edits files without asking you first` +
      (agentId === 'codex' ? ', outside its sandbox' : '') +
      '. Faulty or manipulated instructions — from a web page, a file, a dependency or another agent — ' +
      'can then run unwanted commands on this machine with your rights. Use it only in a disposable ' +
      'or well-isolated environment.'
  }
}

export interface WorkerModeInput {
  /** Agent the worker runs. */
  agentId: string | undefined
  /** Agent of the pane that asked for the worker (worktree.spawn caller). */
  requesterAgentId?: string
  /** That pane's own launch mode choice. */
  requesterMode?: string
  /** Settings defaults per agent. */
  prefs: LaunchModePrefs
  /** User opted in (Agent safety) to workers inheriting a dangerous mode of
   *  the same agent; callers pass false under the admin bypass lock. */
  inheritBypass?: boolean
}

/**
 * Launch mode for a `worktree.spawn` worker. Always an explicit id (for
 * agents with modes) so a bypass Settings default cannot leak in later via
 * `resolveLaunchMode`. A bypassed agent must not multiply itself: a
 * dangerous requester mode or Settings default is skipped and the worker
 * falls back to the next safe choice — safe requester mode (same agent only,
 * mode ids are per-agent) → safe Settings default → template default.
 * With `inheritBypass` (user setting, default off) a same-agent worker takes
 * the requester's mode even when dangerous; the Settings default never leaks.
 */
export function workerLaunchMode(input: WorkerModeInput): string | undefined {
  const { agentId } = input
  if (agentId === undefined || launchMode(agentId, undefined) === undefined) return undefined
  const known = (id: string | undefined): id is string =>
    TEMPLATES.find((t) => t.id === agentId)?.launchModes?.some((m) => m.id === id) === true
  const safe = (id: string | undefined): id is string => known(id) && !isDangerousLaunchMode(agentId, id)
  if (input.requesterAgentId === agentId) {
    if (safe(input.requesterMode)) return input.requesterMode
    // Opt-in only: the user chose that a bypassed agent may multiply itself.
    if (input.inheritBypass === true && known(input.requesterMode)) return input.requesterMode
  }
  const pref = input.prefs[agentId]
  if (safe(pref)) return pref
  return launchMode(agentId, undefined)!.id
}

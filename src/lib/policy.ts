/**
 * Admin policy (registry/GPO, `src-tauri/src/policy.rs`) as the renderer sees
 * it. Display only: every lock is enforced again in Rust at its point of
 * action, so these helpers just decide what to grey out and what to list.
 * Field names are in lockstep with `PolicyView` (camelCase serde).
 */
export type EnvPolicyMode = 'default' | 'strict'

export interface AdminPolicy {
  disableBypassModes: boolean
  disableWarRoomExecute: boolean
  disableWorktreeSpawn: boolean
  disableMcp: boolean
  disableCompanion: boolean
  disableModelDownload: boolean
  disableRoutineCommands: boolean
  disablePreviewBrowser: boolean
  /** Set = the environment filter is forced on with at least this mode. */
  envPolicy: EnvPolicyMode | null
  envAllow: string[]
  /** Any value set. */
  locked: boolean
  /** Registry value names of the active policies. */
  active: string[]
}

export const MANAGED_LABEL = 'Managed by your administrator'

export const UNMANAGED_POLICY: AdminPolicy = {
  disableBypassModes: false,
  disableWarRoomExecute: false,
  disableWorktreeSpawn: false,
  disableMcp: false,
  disableCompanion: false,
  disableModelDownload: false,
  disableRoutineCommands: false,
  disablePreviewBrowser: false,
  envPolicy: null,
  envAllow: [],
  locked: false,
  active: []
}

const FLAGS = [
  'disableBypassModes',
  'disableWarRoomExecute',
  'disableWorktreeSpawn',
  'disableMcp',
  'disableCompanion',
  'disableModelDownload',
  'disableRoutineCommands',
  'disablePreviewBrowser'
] as const

/** Field-wise validation of the IPC answer: only a literal `true` locks. A
 *  malformed answer reads as unmanaged, which is safe because Rust enforces
 *  regardless of what the UI shows. */
export function parseAdminPolicy(raw: unknown): AdminPolicy {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: AdminPolicy = { ...UNMANAGED_POLICY, envAllow: [], active: [] }
  for (const f of FLAGS) out[f] = o[f] === true
  out.envPolicy = o.envPolicy === 'default' || o.envPolicy === 'strict' ? o.envPolicy : null
  out.envAllow = Array.isArray(o.envAllow) ? o.envAllow.filter((s): s is string => typeof s === 'string') : []
  out.active = Array.isArray(o.active) ? o.active.filter((s): s is string => typeof s === 'string') : []
  out.locked = out.active.length > 0
  return out
}

/** What each value does, for Settings → About's list. */
export const POLICY_DESCRIPTIONS: Record<string, string> = {
  DisableBypassModes: 'Bypass/YOLO launch modes are blocked',
  DisableWarRoomExecute: 'Agents cannot run prompts in other panes (War Room execute)',
  DisableWorktreeSpawn: 'Agents cannot spawn worktree workers',
  DisableMcp: 'The Swarmterm MCP server is off',
  DisableCompanion: 'Voice companion install, updates and autostart are blocked',
  DisableModelDownload: 'Speech model downloads are blocked',
  DisableRoutineCommands: 'Command routines are blocked',
  DisablePreviewBrowser: 'The web preview is off',
  EnvPolicy: 'The environment filter is forced on',
  EnvAllow: 'Extra environment names are allowed by the administrator'
}

/** One line per active policy, in the order Rust reported them. */
export function describeActivePolicies(policy: AdminPolicy): string[] {
  return policy.active.map((name) => {
    const text = POLICY_DESCRIPTIONS[name] ?? name
    if (name === 'EnvPolicy' && policy.envPolicy) return `${text} (${policy.envPolicy})`
    if (name === 'EnvAllow') return `${text}: ${policy.envAllow.join(', ')}`
    return text
  })
}

/** Launch modes a user may pick: dangerous ones are locked under DisableBypassModes. */
export function isLaunchModeLocked(policy: AdminPolicy, dangerous: boolean): boolean {
  return dangerous && policy.disableBypassModes
}

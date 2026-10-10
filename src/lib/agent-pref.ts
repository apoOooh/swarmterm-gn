import {
  DEFAULT_TEMPLATE_ID,
  TEMPLATES,
  isTemplateAvailable,
  launchMode,
  type AgentAvailabilityMap
} from '@/lib/templates'

/** localStorage key the global default split agent is persisted under. */
export const DEFAULT_AGENT_STORAGE_KEY = 'cc-default-agent'

/** Minimal storage surface — lets tests pass a fake in place of localStorage. */
export interface AgentPrefStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** Exact catalog lookup — `templateById` would silently map a typo onto
 *  `terminal`, which hides a stale id instead of normalising it. */
export function isKnownAgentId(id: string | null | undefined): id is string {
  return id != null && TEMPLATES.some((t) => t.id === id)
}

/** Read the persisted default, falling back to a plain terminal for missing or
 *  unknown ids (an agent removed from the catalog in a later release). */
export function readStoredDefaultAgent(storage: AgentPrefStorage): string {
  const raw = storage.getItem(DEFAULT_AGENT_STORAGE_KEY)
  return isKnownAgentId(raw) ? raw : DEFAULT_TEMPLATE_ID
}

/** Persist the chosen default agent id. */
export function storeDefaultAgent(storage: AgentPrefStorage, id: string): void {
  storage.setItem(DEFAULT_AGENT_STORAGE_KEY, id)
}

export interface SplitAgentInput {
  /** Per-workspace override; undefined ⇒ inherit the global default. */
  workspaceDefault?: string
  /** Global default from Settings. */
  globalDefault: string
  availability: AgentAvailabilityMap
  /** Alt+click on a split button: always a plain shell. */
  forcePlain?: boolean
}

/**
 * The agent a freshly split pane runs. Precedence: plain override →
 * workspace default → global default → terminal. An agent whose CLI the probe
 * reports missing degrades to a plain shell rather than spawning a command
 * that fails with "not recognized" — the user can still pick it from the
 * pane's agent menu once installed.
 */
export function resolveSplitAgent(input: SplitAgentInput): string {
  if (input.forcePlain) return DEFAULT_TEMPLATE_ID
  const candidate = isKnownAgentId(input.workspaceDefault)
    ? input.workspaceDefault
    : isKnownAgentId(input.globalDefault)
      ? input.globalDefault
      : DEFAULT_TEMPLATE_ID
  const template = TEMPLATES.find((t) => t.id === candidate)!
  return isTemplateAvailable(template, input.availability) ? candidate : DEFAULT_TEMPLATE_ID
}

/** localStorage key the per-agent default launch modes are persisted under. */
export const DEFAULT_LAUNCH_MODES_STORAGE_KEY = 'cc-default-launch-modes'

/** Agent id → launch-mode id a fresh pane of that agent starts in. */
export type LaunchModePrefs = Record<string, string>

/** True when `modeId` is one of the agent's declared launch modes. Exact
 *  lookup — `launchMode` falls back to the first mode, which would hide a
 *  stale id instead of dropping it. */
function isKnownLaunchMode(agentId: string, modeId: unknown): modeId is string {
  return TEMPLATES.find((t) => t.id === agentId)?.launchModes?.some((m) => m.id === modeId) === true
}

/** Read the persisted per-agent modes. Garbage JSON, unknown agents and modes
 *  removed from the catalog are dropped, so the template default applies. */
export function readStoredLaunchModes(storage: AgentPrefStorage): LaunchModePrefs {
  let parsed: unknown
  try {
    parsed = JSON.parse(storage.getItem(DEFAULT_LAUNCH_MODES_STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const prefs: LaunchModePrefs = {}
  for (const [agentId, modeId] of Object.entries(parsed)) {
    if (isKnownLaunchMode(agentId, modeId)) prefs[agentId] = modeId
  }
  return prefs
}

/** Persist the per-agent launch modes. */
export function storeLaunchModes(storage: AgentPrefStorage, prefs: LaunchModePrefs): void {
  storage.setItem(DEFAULT_LAUNCH_MODES_STORAGE_KEY, JSON.stringify(prefs))
}

/**
 * The launch mode a pane runs under. Precedence: the pane's own choice →
 * the Settings default for that agent → the template's first mode.
 * `undefined` for agents without modes.
 */
export function resolveLaunchMode(
  agentId: string | undefined,
  paneMode: string | undefined,
  prefs: LaunchModePrefs
): string | undefined {
  if (agentId === undefined) return undefined
  const candidate = isKnownLaunchMode(agentId, paneMode) ? paneMode : prefs[agentId]
  return launchMode(agentId, candidate)?.id
}

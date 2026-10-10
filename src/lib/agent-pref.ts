import {
  DEFAULT_TEMPLATE_ID,
  TEMPLATES,
  isTemplateAvailable,
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

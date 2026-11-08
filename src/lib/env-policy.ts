/**
 * Settings → Terminal "Environment": what panes and command routines inherit
 * from Swarmterm's own environment. Enforced in Rust (`terminal_env::EnvPolicy`);
 * the renderer only stores and pushes it. Field names are in lockstep with
 * that struct (camelCase serde).
 */
export type EnvFilterMode = 'default' | 'strict'

export interface EnvPolicy {
  /** true = pass everything, the behaviour before this setting existed. */
  passSecrets: boolean
  /** default = drop secret-looking names; strict = keep only system variables. */
  mode: EnvFilterMode
  /** Names that always pass (case-insensitive, trailing `*` = prefix). */
  allow: string[]
}

export const DEFAULT_ENV_POLICY: EnvPolicy = { passSecrets: false, mode: 'default', allow: [] }

export const ENV_POLICY_KEY = 'swarmterm.envPolicy'

const MODES: readonly EnvFilterMode[] = ['default', 'strict']
/** A variable name, optionally ending in `*`; a bare `*` would turn the filter off. */
const NAME = /^[A-Za-z_][A-Za-z0-9_().]*\*?$/

function cleanNames(items: unknown[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!NAME.test(name)) continue
    if (out.some((n) => n.toUpperCase() === name.toUpperCase())) continue
    out.push(name)
  }
  return out
}

/** The "Always pass these variables" text box → names. */
export function parseAllowList(text: string): string[] {
  return cleanNames(text.split(/[\s,]+/))
}

/** Entries of the text box that are not variable names (shown, not stored). */
export function ignoredAllowEntries(text: string): string[] {
  return text.split(/[\s,]+/).filter((t) => t !== '' && !NAME.test(t))
}

/** Field-wise validation: a bad field falls back to the secure default. */
export function parseEnvPolicy(raw: unknown): EnvPolicy {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    passSecrets: o.passSecrets === true,
    mode: MODES.includes(o.mode as EnvFilterMode) ? (o.mode as EnvFilterMode) : DEFAULT_ENV_POLICY.mode,
    allow: Array.isArray(o.allow) ? cleanNames(o.allow) : []
  }
}

export function readEnvPolicy(storage: Pick<Storage, 'getItem'>): EnvPolicy {
  try {
    const stored = storage.getItem(ENV_POLICY_KEY)
    if (stored !== null) return parseEnvPolicy(JSON.parse(stored))
  } catch {
    // Unreadable or corrupt storage: the defaults below.
  }
  return { ...DEFAULT_ENV_POLICY, allow: [] }
}

export function storeEnvPolicy(storage: Pick<Storage, 'setItem'>, policy: EnvPolicy): void {
  try {
    storage.setItem(ENV_POLICY_KEY, JSON.stringify(policy))
  } catch {
    // Full or blocked storage: the setting still applies for this session.
  }
}

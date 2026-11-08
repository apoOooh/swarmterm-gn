import { collectLeaves, type LayoutNode } from '@/lib/layout-tree'

/**
 * Settings → Terminal "Process priority" (ADR 0005). Enforced by the panes'
 * Job Objects in Rust; the renderer only stores and pushes it. Field names
 * and values are in lockstep with `swarmterm_host::priority::Settings`.
 */
export type PriorityMode = 'off' | 'strict' | 'agent-normal'
/** Only below-Normal classes exist: no setting can run pane work at Normal. */
export type PriorityLevel = 'below-normal' | 'idle'

export interface PrioritySettings {
  mode: PriorityMode
  /** Whole pane, agent included (strict mode only). */
  paneLevel: PriorityLevel
  /** Everything an agent starts (builds, tools), both modes. */
  buildLevel: PriorityLevel
  /** Hard CPU cap per pane in percent of the machine (1–99), null = none. */
  cpuCap: number | null
}

export const DEFAULT_PRIORITY: PrioritySettings = {
  mode: 'strict',
  paneLevel: 'below-normal',
  buildLevel: 'idle',
  cpuCap: null
}

/** localStorage key of the settings object (JSON). */
export const PRIORITY_KEY = 'swarmterm.processPriority'
/** Old boolean "Lower build priority" key, migrated on first read. */
export const LEGACY_BUILD_PRIORITY_KEY = 'swarmterm.lowerBuildPriority'

const MODES: readonly PriorityMode[] = ['off', 'strict', 'agent-normal']
const LEVELS: readonly PriorityLevel[] = ['below-normal', 'idle']

/** 1–99 whole percent, anything else = no cap. */
export function normalizeCpuCap(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.round(v)
  return n >= 1 && n <= 99 ? n : null
}

function pick<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

/** Field-wise validation: a bad field falls back to its default, never to "off". */
export function parsePriority(raw: unknown): PrioritySettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    mode: pick(o.mode, MODES, DEFAULT_PRIORITY.mode),
    paneLevel: pick(o.paneLevel, LEVELS, DEFAULT_PRIORITY.paneLevel),
    buildLevel: pick(o.buildLevel, LEVELS, DEFAULT_PRIORITY.buildLevel),
    cpuCap: normalizeCpuCap(o.cpuCap)
  }
}

/**
 * Stored settings, else the migrated old boolean (`'false'` ⇒ off, anything
 * else ⇒ defaults), else the defaults. Unreadable storage ⇒ defaults.
 */
export function readPriority(storage: Pick<Storage, 'getItem'>): PrioritySettings {
  try {
    const stored = storage.getItem(PRIORITY_KEY)
    if (stored !== null) {
      try {
        return parsePriority(JSON.parse(stored))
      } catch {
        return { ...DEFAULT_PRIORITY }
      }
    }
    if (storage.getItem(LEGACY_BUILD_PRIORITY_KEY) === 'false') return { ...DEFAULT_PRIORITY, mode: 'off' }
  } catch {
    // Unreadable storage: the defaults below.
  }
  return { ...DEFAULT_PRIORITY }
}

/** Writes the new key and drops the legacy one (migration done). */
export function storePriority(storage: Pick<Storage, 'setItem' | 'removeItem'>, s: PrioritySettings): void {
  try {
    storage.setItem(PRIORITY_KEY, JSON.stringify(s))
    storage.removeItem(LEGACY_BUILD_PRIORITY_KEY)
  } catch {
    // Private mode / quota: the in-memory value still applies this session.
  }
}

/**
 * Terminal ids of every pane in a workspace that opted out
 * (`normalBuildPriority`), sorted so callers can compare a joined key and only
 * push to Rust when the set really changed.
 */
export function exemptTerminalIds(
  workspaces: readonly { layout: LayoutNode; normalBuildPriority?: boolean }[]
): string[] {
  const ids: string[] = []
  for (const ws of workspaces) {
    if (!ws.normalBuildPriority) continue
    for (const leaf of collectLeaves(ws.layout)) ids.push(leaf.terminalId)
  }
  return ids.sort()
}

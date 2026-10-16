import { TEMPLATES, DEFAULT_TEMPLATE_ID } from '@/lib/templates'
import { TERMINAL_COUNTS } from '@/lib/layout-tree'
import { clampCounts } from '@/lib/agent-allocation'
import type { AccountSelection } from '@/lib/agent-accounts'

/**
 * The composer's starting values for a new workspace. Holds layout choices
 * only — never prompts, output or startup commands (same rule as saved
 * workspaces).
 */
export interface WorkspacePreset {
  /** Working folder; '' ⇒ the home directory. */
  folder: string
  /** One of TERMINAL_COUNTS. */
  terminalCount: number
  /** Agent template id → pane count; plain terminals fill the rest. */
  agentCounts: Record<string, number>
  /** Account choice per agent CLI (Claude Code / Codex). */
  accountSelections: Record<string, AccountSelection>
  /** "Isolate features in git worktrees". */
  isolateWorktrees: boolean
  /** "Split opens" override; '' ⇒ follow the Settings default. */
  splitAgent: string
}

/** A named preset the user can pick in the composer. */
export interface WorkspacePresetTemplate extends WorkspacePreset {
  id: string
  name: string
}

export const WORKSPACE_DEFAULTS_STORAGE_KEY = 'swarmterm.workspaceDefaults'
export const WORKSPACE_TEMPLATES_STORAGE_KEY = 'swarmterm.workspaceTemplates'
const TEMPLATES_VERSION = 1

/** What the composer used before defaults were configurable. */
export const BUILTIN_DEFAULT_PRESET: WorkspacePreset = {
  folder: '',
  terminalCount: 2,
  agentCounts: { 'claude-code': 1 },
  accountSelections: {},
  isolateWorktrees: false,
  splitAgent: ''
}

const KNOWN_AGENT_IDS = new Set(TEMPLATES.map((t) => t.id))
const ACCOUNT_AGENT_IDS = new Set(['claude-code', 'codex'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function normalizeAccountSelection(v: unknown): AccountSelection | null {
  if (!isRecord(v)) return null
  if (v.mode === 'round-robin') return { mode: 'round-robin' }
  if (v.mode === 'fixed') {
    return typeof v.accountId === 'string' && v.accountId !== ''
      ? { mode: 'fixed', accountId: v.accountId }
      : { mode: 'fixed' }
  }
  return null
}

/** Validate untrusted (stored / edited) data into a usable preset. */
export function normalizePreset(raw: unknown): WorkspacePreset {
  const r = isRecord(raw) ? raw : {}
  const counts = TERMINAL_COUNTS as readonly number[]
  const terminalCount =
    typeof r.terminalCount === 'number' && counts.includes(r.terminalCount)
      ? r.terminalCount
      : BUILTIN_DEFAULT_PRESET.terminalCount

  const agentCounts: Record<string, number> = {}
  if (isRecord(r.agentCounts)) {
    for (const [id, n] of Object.entries(r.agentCounts)) {
      if (id === DEFAULT_TEMPLATE_ID || !KNOWN_AGENT_IDS.has(id)) continue
      if (typeof n === 'number' && Number.isFinite(n) && n >= 1) agentCounts[id] = Math.floor(n)
    }
  } else if (r.agentCounts === undefined && !isRecord(raw)) {
    Object.assign(agentCounts, BUILTIN_DEFAULT_PRESET.agentCounts)
  }

  const accountSelections: Record<string, AccountSelection> = {}
  if (isRecord(r.accountSelections)) {
    for (const [id, sel] of Object.entries(r.accountSelections)) {
      if (!ACCOUNT_AGENT_IDS.has(id)) continue
      const ok = normalizeAccountSelection(sel)
      if (ok) accountSelections[id] = ok
    }
  }

  return {
    // Not trimmed: the Settings editor saves on every keystroke, and trimming
    // here would eat the space in a half-typed `C:\My Projects`. Callers trim.
    folder: typeof r.folder === 'string' ? r.folder : '',
    terminalCount,
    agentCounts: clampCounts(agentCounts, terminalCount),
    accountSelections,
    isolateWorktrees: r.isolateWorktrees === true,
    splitAgent: typeof r.splitAgent === 'string' && KNOWN_AGENT_IDS.has(r.splitAgent) ? r.splitAgent : ''
  }
}

/** Minimal storage surface — lets tests pass a fake in place of localStorage. */
export interface PresetStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function readStoredDefaultPreset(storage: PresetStorage): WorkspacePreset {
  const parsed = parseJson(storage.getItem(WORKSPACE_DEFAULTS_STORAGE_KEY))
  return parsed === undefined ? { ...BUILTIN_DEFAULT_PRESET } : normalizePreset(parsed)
}

export function storeDefaultPreset(storage: PresetStorage, preset: WorkspacePreset): void {
  storage.setItem(WORKSPACE_DEFAULTS_STORAGE_KEY, JSON.stringify(normalizePreset(preset)))
}

export function readStoredTemplates(storage: PresetStorage): WorkspacePresetTemplate[] {
  const parsed = parseJson(storage.getItem(WORKSPACE_TEMPLATES_STORAGE_KEY))
  if (!isRecord(parsed) || parsed.version !== TEMPLATES_VERSION || !Array.isArray(parsed.templates)) return []
  const out: WorkspacePresetTemplate[] = []
  const seen = new Set<string>()
  for (const t of parsed.templates) {
    if (!isRecord(t) || typeof t.id !== 'string' || typeof t.name !== 'string') continue
    const name = t.name.trim()
    if (name === '' || seen.has(t.id)) continue
    seen.add(t.id)
    out.push({ ...normalizePreset(t), id: t.id, name })
  }
  return out
}

export function storeTemplates(storage: PresetStorage, templates: WorkspacePresetTemplate[]): void {
  storage.setItem(
    WORKSPACE_TEMPLATES_STORAGE_KEY,
    JSON.stringify({ version: TEMPLATES_VERSION, templates })
  )
}

/** Case-insensitive lookup — template names are unique ignoring case. */
export function findTemplateByName(
  templates: WorkspacePresetTemplate[],
  name: string
): WorkspacePresetTemplate | undefined {
  const key = name.trim().toLowerCase()
  return templates.find((t) => t.name.toLowerCase() === key)
}

/** `base`, or `base (2)`, `base (3)`… — the first name not taken. */
export function uniqueTemplateName(templates: WorkspacePresetTemplate[], base: string): string {
  const trimmed = base.trim() || 'Template'
  if (!findTemplateByName(templates, trimmed)) return trimmed
  for (let i = 2; ; i++) {
    const candidate = `${trimmed} (${i})`
    if (!findTemplateByName(templates, candidate)) return candidate
  }
}

export function addTemplate(
  templates: WorkspacePresetTemplate[],
  name: string,
  preset: WorkspacePreset,
  id: string
): WorkspacePresetTemplate[] {
  return [...templates, { ...normalizePreset(preset), id, name: uniqueTemplateName(templates, name) }]
}

/** Replace the template `id`; a rename onto another template's name is made unique. */
export function updateTemplate(
  templates: WorkspacePresetTemplate[],
  id: string,
  name: string,
  preset: WorkspacePreset
): WorkspacePresetTemplate[] {
  const others = templates.filter((t) => t.id !== id)
  return templates.map((t) =>
    t.id === id ? { ...normalizePreset(preset), id, name: uniqueTemplateName(others, name) } : t
  )
}

export function removeTemplate(templates: WorkspacePresetTemplate[], id: string): WorkspacePresetTemplate[] {
  return templates.filter((t) => t.id !== id)
}

/** "4 terminals · 2 Claude Code · 1 Codex" */
export function presetSummary(preset: WorkspacePreset, nameOf: (id: string) => string): string {
  const parts = [`${preset.terminalCount} ${preset.terminalCount === 1 ? 'terminal' : 'terminals'}`]
  for (const t of TEMPLATES) {
    const n = preset.agentCounts[t.id]
    if (n) parts.push(`${n} ${nameOf(t.id)}`)
  }
  if (preset.isolateWorktrees) parts.push('worktrees')
  return parts.join(' · ')
}

/**
 * Agents a preset asks for but that aren't installed are dropped so the
 * composer never starts with a pane that cannot launch.
 */
export function withAvailableAgents(
  preset: WorkspacePreset,
  isAvailable: (agentId: string) => boolean
): WorkspacePreset {
  const agentCounts: Record<string, number> = {}
  for (const [id, n] of Object.entries(preset.agentCounts)) if (isAvailable(id)) agentCounts[id] = n
  return { ...preset, agentCounts }
}

/**
 * Fit a preset next to `extraPanes` already-chosen panes (resumed sessions)
 * without breaching the 12-pane cap: the terminal count drops to the largest
 * TERMINAL_COUNTS value that still fits, agent counts are clamped to it.
 */
export function fitPresetToCap(preset: WorkspacePreset, extraPanes: number): WorkspacePreset {
  const max = TERMINAL_COUNTS[TERMINAL_COUNTS.length - 1]
  const fitting = TERMINAL_COUNTS.filter((n) => n + extraPanes <= max)
  const terminalCount = fitting.includes(preset.terminalCount as (typeof TERMINAL_COUNTS)[number])
    ? preset.terminalCount
    : (fitting[fitting.length - 1] ?? TERMINAL_COUNTS[0])
  return { ...preset, terminalCount, agentCounts: clampCounts(preset.agentCounts, terminalCount) }
}

/** Fixed account choices pointing at a deleted account fall back to the default account. */
export function withKnownAccounts(
  selections: Record<string, AccountSelection>,
  knownAccountIds: ReadonlySet<string>
): Record<string, AccountSelection> {
  const out: Record<string, AccountSelection> = {}
  for (const [agentId, sel] of Object.entries(selections)) {
    if (sel.mode === 'fixed' && sel.accountId !== undefined && !knownAccountIds.has(sel.accountId)) continue
    out[agentId] = sel
  }
  return out
}

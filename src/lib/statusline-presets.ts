/**
 * Status line templates (SWA-92). The Rust side owns rendering; this module
 * holds the settings shape (serde camelCase, in lockstep with
 * `src-tauri/src/statusline/settings.rs`) and the picker's rules.
 *
 * "Off" is not stored in `statusline.json`: it is the existing switch that
 * removes our `statusLine` entry (`statusline-store`), so installs from
 * before SWA-92 keep their state — on = Compact, off = Off.
 */
export type Preset = 'compact' | 'extended' | 'detailed' | 'custom'
export type Choice = Preset | 'off'
export type Scheme = 'subtle' | 'app-theme' | 'high-contrast'
export type Animation = 'off' | 'subtle'

/** Parts of a Custom Claude line (SWA-93), in lockstep with `Segment` in `settings.rs`. */
export type Segment =
  | 'model'
  | 'effort'
  | 'cost'
  | 'five-hour'
  | 'seven-day'
  | 'cache'
  | 'agents'
  | 'token-bars'
  | 'branch'
  | 'mcp'

export interface Slot<T extends string = string> {
  id: T
  on: boolean
}

export const SEGMENTS: { id: Segment; label: string; text: string }[] = [
  { id: 'model', label: 'Model and context', text: 'Model name and context bar.' },
  { id: 'effort', label: 'Effort', text: 'Shown next to the model.' },
  { id: 'cost', label: 'Session cost', text: 'Shown next to the model.' },
  { id: 'five-hour', label: '5h limit', text: 'Usage and time to reset.' },
  { id: 'seven-day', label: '7d limit', text: 'Usage and time to reset.' },
  { id: 'cache', label: 'Prompt cache', text: 'Hit ratio, warm or cold. Hidden below 50 columns.' },
  { id: 'agents', label: 'Subagents', text: 'Count, tokens and cost (estimates). Hidden below 50 columns.' },
  { id: 'token-bars', label: 'Token bars', text: 'Extra rows below the line.' },
  { id: 'branch', label: 'Git branch', text: 'Hidden below 50 columns.' },
  { id: 'mcp', label: 'MCP link', text: 'Whether the pane reaches Swarmterm.' }
]

const DEFAULT_ON: Segment[] = ['model', 'effort', 'five-hour', 'seven-day', 'branch', 'mcp']

export const DEFAULT_SEGMENTS: Slot<Segment>[] = SEGMENTS.map((s) => ({ id: s.id, on: DEFAULT_ON.includes(s.id) }))

/**
 * Every id of `all` exactly once, in the saved order: unknown and duplicate
 * entries dropped, missing ones appended switched off (same rule as Rust).
 */
export function normalizeSlots<T extends string>(list: readonly Slot<string>[] | null | undefined, all: readonly T[]): Slot<T>[] {
  const out: Slot<T>[] = []
  for (const s of list ?? []) {
    if ((all as readonly string[]).includes(s.id) && !out.some((o) => o.id === s.id)) {
      out.push({ id: s.id as T, on: !!s.on })
    }
  }
  for (const id of all) if (!out.some((o) => o.id === id)) out.push({ id, on: false })
  return out
}

/** Moves entry `i` by `delta` places; out of range = unchanged copy. */
export function moveSlot<T extends string>(list: readonly Slot<T>[], i: number, delta: number): Slot<T>[] {
  const j = i + delta
  const out = [...list]
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return out
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

export function toggleSlot<T extends string>(list: readonly Slot<T>[], i: number): Slot<T>[] {
  return list.map((s, k) => (k === i ? { ...s, on: !s.on } : s))
}

export interface StatuslineSettings {
  claude: Preset
  codex: Preset | null
  codexEnabled: boolean
  codexUseColors: boolean
  scheme: Scheme
  vibrance: number
  animation: Animation
  themeText: string | null
  themeAccent: string | null
  claudeSegments: Slot<Segment>[]
  codexItems: Slot[]
}

export const DEFAULT_STATUSLINE_SETTINGS: StatuslineSettings = {
  claude: 'compact',
  codex: null,
  codexEnabled: true,
  codexUseColors: false,
  scheme: 'subtle',
  vibrance: 50,
  animation: 'off',
  themeText: null,
  themeAccent: null,
  claudeSegments: DEFAULT_SEGMENTS,
  codexItems: []
}

export const CHOICES: { id: Choice; label: string; text: string }[] = [
  { id: 'off', label: 'Off', text: 'No status line from Swarmterm.' },
  { id: 'compact', label: 'Compact', text: 'MCP link, model and context.' },
  { id: 'extended', label: 'Extended', text: 'Adds effort, git branch and the 5h / 7d limits.' },
  {
    id: 'detailed',
    label: 'Detailed',
    text: 'Adds cost, prompt cache, subagents and token bars. ≈ marks estimates.'
  },
  { id: 'custom', label: 'Custom', text: 'Pick each part and its order.' }
]

export const SCHEMES: { id: Scheme; label: string; text: string }[] = [
  { id: 'subtle', label: 'Subtle', text: 'Near-monochrome, only warnings tinted.' },
  { id: 'app-theme', label: 'App theme', text: 'Text and accent from the active Swarmterm theme.' },
  { id: 'high-contrast', label: 'High contrast', text: 'The terminal’s 16 basic colours.' }
]

/** Vibrance only changes colours that have a hue to scale. */
export function vibranceApplies(scheme: Scheme): boolean {
  return scheme === 'app-theme'
}

export function choiceOf(enabled: boolean, s: StatuslineSettings): Choice {
  return enabled ? s.claude : 'off'
}

export function clampVibrance(n: number): number {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 50
}

/** Settings as they come back from Rust, filled with defaults. */
export function normalizeSettings(raw: Partial<StatuslineSettings> | null | undefined): StatuslineSettings {
  const s = { ...DEFAULT_STATUSLINE_SETTINGS, ...(raw ?? {}) }
  return {
    ...s,
    vibrance: clampVibrance(s.vibrance),
    claudeSegments: normalizeSlots(
      s.claudeSegments,
      SEGMENTS.map((x) => x.id)
    ),
    codexItems: Array.isArray(s.codexItems) ? s.codexItems : []
  }
}

/**
 * Status line templates (SWA-92). The Rust side owns rendering; this module
 * holds the settings shape (serde camelCase, in lockstep with
 * `src-tauri/src/statusline/settings.rs`) and the picker's rules.
 *
 * "Off" is not stored in `statusline.json`: it is the existing switch that
 * removes our `statusLine` entry (`statusline-store`), so installs from
 * before SWA-92 keep their state — on = Compact, off = Off.
 */
export type Preset = 'compact' | 'extended' | 'detailed'
export type Choice = Preset | 'off'
export type Scheme = 'subtle' | 'app-theme' | 'high-contrast'
export type Animation = 'off' | 'subtle'

export interface StatuslineSettings {
  claude: Preset
  scheme: Scheme
  vibrance: number
  animation: Animation
  themeText: string | null
  themeAccent: string | null
}

export const DEFAULT_STATUSLINE_SETTINGS: StatuslineSettings = {
  claude: 'compact',
  scheme: 'subtle',
  vibrance: 50,
  animation: 'off',
  themeText: null,
  themeAccent: null
}

export const CHOICES: { id: Choice; label: string; text: string }[] = [
  { id: 'off', label: 'Off', text: 'No status line from Swarmterm.' },
  { id: 'compact', label: 'Compact', text: 'MCP link, model and context.' },
  { id: 'extended', label: 'Extended', text: 'Adds effort, git branch and the 5h / 7d limits.' },
  {
    id: 'detailed',
    label: 'Detailed',
    text: 'Adds cost, prompt cache, subagents and token bars. ≈ marks estimates.'
  }
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
  return { ...s, vibrance: clampVibrance(s.vibrance) }
}

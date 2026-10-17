/** How long a working agent takes to drift from yellow to orange. 0 = no drift. */
export type GradientMinutes = 0 | 5 | 10 | 30

export const GRADIENT_MINUTES_OPTIONS: readonly GradientMinutes[] = [0, 5, 10, 30]

/** User preferences for tinting panes by agent state. Persisted to localStorage. */
export interface PaneStatusPrefs {
  enabled: boolean
  gradientMinutes: GradientMinutes
}

/** Off by default: a coloured frame on every pane is a look the user opts into. */
export const DEFAULT_PANE_STATUS_PREFS: PaneStatusPrefs = { enabled: false, gradientMinutes: 10 }

/** localStorage key the pane status preference is persisted under. */
export const PANE_STATUS_PREF_STORAGE_KEY = 'swarmterm.paneStatusHighlight'

/** Minimal storage surface — lets tests pass a fake in place of localStorage. */
export interface PaneStatusPrefStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function isGradientMinutes(v: unknown): v is GradientMinutes {
  return GRADIENT_MINUTES_OPTIONS.includes(v as GradientMinutes)
}

/** Per-field tolerant parse: any invalid field falls back alone, never the whole blob. */
export function readStoredPaneStatusPrefs(storage: PaneStatusPrefStorage): PaneStatusPrefs {
  const raw = storage.getItem(PANE_STATUS_PREF_STORAGE_KEY)
  if (raw === null) return DEFAULT_PANE_STATUS_PREFS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_PANE_STATUS_PREFS
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PANE_STATUS_PREFS
  const obj = parsed as Record<string, unknown>
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_PANE_STATUS_PREFS.enabled,
    gradientMinutes: isGradientMinutes(obj.gradientMinutes)
      ? obj.gradientMinutes
      : DEFAULT_PANE_STATUS_PREFS.gradientMinutes
  }
}

export function storePaneStatusPrefs(storage: PaneStatusPrefStorage, prefs: PaneStatusPrefs): void {
  storage.setItem(PANE_STATUS_PREF_STORAGE_KEY, JSON.stringify(prefs))
}

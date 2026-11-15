import { normalizeSlots, type Preset, type Slot } from './statusline-presets'

/**
 * Example text for Codex's built-in status line (SWA-92). Codex draws the
 * line itself from item ids (`[tui] status_line`), so this is only an
 * illustration — one row, made-up numbers, in the order the template writes
 * the items (`src-tauri/src/hook/codex_statusline.rs`).
 */
const SAMPLE: Record<string, string> = {
  'model-with-reasoning': 'gpt-5.5 high',
  'context-remaining': '58% context left',
  'git-branch': 'dev',
  'five-hour-limit': '5h 37%',
  'weekly-limit': 'weekly 59%',
  'used-tokens': '412K used',
  'total-input-tokens': '398K in',
  'total-output-tokens': '14K out',
  'context-window-size': '1M window'
}

export const CODEX_ITEMS: Record<Exclude<Preset, 'custom'>, string[]> = {
  compact: ['model-with-reasoning', 'context-remaining'],
  extended: ['model-with-reasoning', 'context-remaining', 'git-branch', 'five-hour-limit', 'weekly-limit'],
  detailed: [
    'model-with-reasoning',
    'context-remaining',
    'git-branch',
    'five-hour-limit',
    'weekly-limit',
    'used-tokens',
    'total-input-tokens',
    'total-output-tokens',
    'context-window-size'
  ]
}

/** Readable names for the Custom list. */
export const CODEX_ITEM_LABELS: Record<string, string> = {
  'model-with-reasoning': 'Model and reasoning',
  'context-remaining': 'Context left',
  'git-branch': 'Git branch',
  'five-hour-limit': '5h limit',
  'weekly-limit': 'Weekly limit',
  'used-tokens': 'Tokens used',
  'total-input-tokens': 'Input tokens',
  'total-output-tokens': 'Output tokens',
  'context-window-size': 'Window size'
}

/**
 * The Custom list (SWA-93) over the tested items only — Rust writes no other
 * id. An empty saved list starts as Extended.
 */
export function codexCustomItems(saved: readonly Slot[]): Slot[] {
  const seed = saved.length > 0 ? saved : CODEX_ITEMS.extended.map((id) => ({ id, on: true }))
  return normalizeSlots(seed, CODEX_ITEMS.detailed)
}

export function codexPreviewLine(preset: Preset, custom: readonly Slot[] = []): string {
  const ids = preset === 'custom' ? codexCustomItems(custom).filter((s) => s.on).map((s) => s.id) : CODEX_ITEMS[preset]
  return ids.map((id) => SAMPLE[id] ?? id).join(' · ')
}

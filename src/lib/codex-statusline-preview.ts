import type { Preset } from './statusline-presets'

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

export const CODEX_ITEMS: Record<Preset, string[]> = {
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

export function codexPreviewLine(preset: Preset): string {
  return CODEX_ITEMS[preset].map((id) => SAMPLE[id] ?? id).join(' · ')
}

import { invoke } from '@tauri-apps/api/core'
import type { Preset } from '@/lib/statusline-presets'

/**
 * Install (or remove) Claude Code's `statusLine` entry in the user-scope
 * settings file. Rejects when the user already owns a custom status line — the
 * backend refuses to overwrite it, which is a legitimate configuration rather
 * than a failure worth surfacing.
 */
export const setClaudeStatusline = (enabled: boolean): Promise<void> =>
  invoke('set_claude_statusline', { enabled })

export interface CodexStatuslineStatus {
  codexHome: string
  state: 'managed' | 'custom' | 'unmanaged' | 'deferred'
  customFields: ('status_line' | 'status_line_use_colors')[]
  version: string | null
  notice: string | null
}

/** Applies to the default CODEX_HOME and all enrolled Codex account profiles. */
export const applyCodexStatusline = (
  preset: Preset,
  useColors: boolean,
  enabled = true
): Promise<CodexStatuslineStatus[]> =>
  invoke('codex_statusline_apply', { preset, useColors, enabled })

export const getCodexStatuslineStatus = (): Promise<CodexStatuslineStatus[]> =>
  invoke('codex_statusline_status')

/** Restores original fields only while their values still match our last write. */
export const releaseCodexStatusline = (): Promise<CodexStatuslineStatus[]> =>
  invoke('codex_statusline_release')

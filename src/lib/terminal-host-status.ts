import type { TerminalHostStatus } from '@/tauri/terminal-host'

/** One line for Settings → Terminal → Terminal host. */
export function describeHostStatus(s: TerminalHostStatus): string {
  if (!s.supported) return 'Only available on Windows.'
  if (!s.enabled) return 'Off: terminals run inside Swarmterm.'
  if (s.connected) return `Connected to terminal host ${s.hostVersion ?? ''}`.trimEnd() + '.'
  if (s.error) return `Unavailable (${s.error}). New panes run inside Swarmterm.`
  return 'On: the host starts with the next new pane.'
}

import type { NewCenterEntry } from '@/lib/notification-center'

/**
 * Agent integration status (SWA-83): what Swarmterm wrote into Claude Code's
 * and Codex's config, as reported by Rust (`setup_status`, src-tauri/src/setup.rs).
 * Field names and state strings are in lockstep with that module's serde.
 *
 * Only an `error` is a problem worth the bell. A CLI that is not installed,
 * a user's own status line, a switch the user turned off or an older Codex
 * are facts the user may want to read in Settings, not alarms — the first
 * start of a fresh machine must not light up the bell.
 */
export type SetupState = 'unknown' | 'ok' | 'off' | 'notInstalled' | 'outdated' | 'foreign' | 'deferred' | 'error'

export interface SetupCheck {
  state: SetupState
  detail: string | null
}

export interface SetupStatus {
  claude: { installed: boolean | null; hooks: SetupCheck; mcp: SetupCheck; statusLine: SetupCheck }
  codex: { installed: boolean | null; hooks: SetupCheck; mcp: SetupCheck }
}

export type SetupTone = 'ok' | 'muted' | 'warn' | 'error'

export interface SetupRow {
  id: string
  agent: string
  item: string
  tone: SetupTone
  text: string
  detail: string | null
}

const ITEMS = [
  { id: 'claude.hooks', agent: 'Claude Code', item: 'hooks', pick: (s: SetupStatus) => s.claude.hooks },
  { id: 'claude.mcp', agent: 'Claude Code', item: 'MCP entry', pick: (s: SetupStatus) => s.claude.mcp },
  { id: 'claude.statusLine', agent: 'Claude Code', item: 'status line', pick: (s: SetupStatus) => s.claude.statusLine },
  { id: 'codex.hooks', agent: 'Codex', item: 'hooks', pick: (s: SetupStatus) => s.codex.hooks },
  { id: 'codex.mcp', agent: 'Codex', item: 'MCP entry', pick: (s: SetupStatus) => s.codex.mcp }
] as const

function describe(id: string, state: SetupState): { tone: SetupTone; text: string } {
  switch (state) {
    case 'ok': return { tone: 'ok', text: 'Set up' }
    case 'off': return { tone: 'muted', text: 'Switched off' }
    case 'notInstalled': return { tone: 'muted', text: 'Not installed — nothing was written' }
    case 'outdated': return {
      tone: 'warn',
      text: id === 'codex.hooks' ? 'Update Codex CLI to save conversations' : 'Update the CLI to use this'
    }
    case 'foreign': return { tone: 'muted', text: 'Your own status line is kept' }
    case 'deferred': return { tone: 'muted', text: 'Left to the installed Swarmterm (development build)' }
    case 'unknown': return { tone: 'muted', text: 'Checking…' }
    case 'error': return { tone: 'error', text: 'Could not be set up' }
  }
}

export function setupRows(status: SetupStatus): SetupRow[] {
  return ITEMS.map(({ id, agent, item, pick }) => {
    const check = pick(status)
    return { id, agent, item, ...describe(id, check.state), detail: check.detail }
  })
}

export function setupProblems(status: SetupStatus): SetupRow[] {
  return setupRows(status).filter(r => r.tone === 'error')
}

/** Pseudo terminal id for the bell (see lib/backend-alerts.ts). */
export const SETUP_ALERT_ID = 'backend:setup'

/** One entry for all problems: a repeat replaces the unread one (addEntry dedupes). */
export function setupBellEntry(status: SetupStatus, at: number): NewCenterEntry | null {
  const problems = setupProblems(status)
  if (problems.length === 0) return null
  const [first] = problems
  const more = problems.length > 1 ? `+${problems.length - 1} more, ` : ''
  return {
    kind: 'backend',
    terminalId: SETUP_ALERT_ID,
    title: 'Agent setup needs attention',
    detail: `${first.agent} ${first.item}: ${first.detail ?? first.text} (${more}see Settings → Setup)`,
    at
  }
}

/**
 * Welcome's note about Codex's one-time `/hooks` trust. Only while Codex
 * panes are about to be created: before, it was shown to everyone with Codex
 * installed, on every visit, whether they used Codex or had trusted already.
 */
export function codexHookHint(input: { codexAvailable: boolean; sessionHooks: boolean; codexCount: number }): string | null {
  if (!input.codexAvailable || input.codexCount <= 0) return null
  return input.sessionHooks
    ? 'First Codex pane: run /hooks once and trust the Swarmterm hooks so conversations can be saved and resumed.'
    : 'Update Codex CLI to save and resume Codex conversations. Workspace layouts are saved either way.'
}

function normalizeFolder(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Home folder, a drive root or a UNC share root: a recursive file watch and an agent's trust prompt for everything in it. */
export function isBroadFolder(path: string, home: string | null): boolean {
  const p = normalizeFolder(path)
  if (p === '') return false
  if (/^[a-z]:$/.test(p)) return true
  // UNC share root (`\\server\share`): the whole share.
  if (/^\/\/[^/]+\/[^/]+$/.test(p)) return true
  return home !== null && p === normalizeFolder(home)
}

/**
 * The folder Welcome starts with: the template's, else the newest recent
 * folder, else nothing — never the home folder (SWA-83: a first workspace in
 * the home folder watched the whole profile and asked agents to trust it).
 */
export function defaultWelcomeFolder(templateFolder: string, recents: readonly string[], home: string | null): string {
  const chosen = templateFolder.trim()
  if (chosen !== '') return chosen
  return recents.find(r => !isBroadFolder(r, home)) ?? ''
}

export type SetupBellAction =
  | { type: 'add'; entry: NewCenterEntry; lastDetail: string }
  | { type: 'markRead'; lastDetail: null }
  | { type: 'none'; lastDetail: string | null }

/**
 * What the bell does for a new setup status, given the detail of the entry
 * it last added: ONE entry per distinct problem (a read entry must not come
 * back on every pane spawn or recheck), marked read once the problem is gone.
 */
export function nextSetupBellAction(lastDetail: string | null, status: SetupStatus, at: number): SetupBellAction {
  const entry = setupBellEntry(status, at)
  if (entry === null) return lastDetail === null ? { type: 'none', lastDetail: null } : { type: 'markRead', lastDetail: null }
  if (entry.detail === lastDetail) return { type: 'none', lastDetail }
  return { type: 'add', entry, lastDetail: entry.detail }
}

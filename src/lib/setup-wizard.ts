/**
 * Setup assistant (SWA-83 phase 2): the rules behind its four steps. The
 * component only renders these; nothing here talks to Rust.
 *
 * D6 (user, 2026-11-09): for anything missing the assistant shows why it is
 * needed, the vendor's page and an install command to COPY. It never
 * installs, and never types a command into a pane.
 */
import type { EnvPolicy } from './env-policy'
import type { AdminPolicy } from './policy'
import { isBroadFolder, type SetupStatus } from './setup-status'
import { DEFAULT_TEMPLATE_ID, TEMPLATES, type AgentAvailabilityMap, type WorkspaceTemplate } from './templates'
import type { VoiceSettings } from '@/tauri/voice'

export const WIZARD_STEPS = ['prerequisites', 'signin', 'voice', 'workspace'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** Pane counts the last step offers; Welcome has the full range. */
export const WIZARD_LAYOUTS = [1, 2, 4] as const

export interface InstallItem {
  name: string
  /** One sentence: why Swarmterm wants it. */
  why: string
  link: string
  /** Checked against the winget catalog before shipping (SWA-83 plan, step 1). */
  winget?: string
  /** Global npm package (needs Node.js from the same list). */
  npm?: string
}

export type InstallId = 'git' | 'node' | 'python' | 'claude-code' | 'codex' | 'opencode'

export const INSTALL_CATALOG: Record<InstallId, InstallItem> = {
  git: {
    name: 'Git for Windows',
    why: 'Worktrees, the Explorer\'s Git view, and Git Bash, which Claude Code needs for its status line.',
    link: 'https://git-scm.com/downloads/win',
    winget: 'Git.Git'
  },
  node: {
    name: 'Node.js LTS',
    why: 'Codex, OpenCode and many MCP servers are installed and run with npm.',
    link: 'https://nodejs.org/en/download',
    winget: 'OpenJS.NodeJS.LTS'
  },
  python: {
    name: 'Python',
    why: 'Optional: only used to run Python files from the Explorer.',
    link: 'https://www.python.org/downloads/windows/',
    winget: 'Python.Python.3.13'
  },
  'claude-code': {
    name: 'Claude Code',
    why: "Anthropic's coding agent.",
    link: 'https://code.claude.com/docs/en/setup',
    winget: 'Anthropic.ClaudeCode'
  },
  codex: {
    name: 'Codex',
    why: "OpenAI's coding agent.",
    link: 'https://developers.openai.com/codex/cli',
    npm: '@openai/codex'
  },
  opencode: {
    name: 'OpenCode',
    why: 'An open-source coding agent for many model providers.',
    link: 'https://opencode.ai/docs/',
    npm: 'opencode-ai'
  }
}

/** The command to copy, or null when only the link helps (no winget, or no npm yet). */
export function installCommand(item: InstallItem, have: { winget: boolean; npm: boolean }): string | null {
  if (item.winget !== undefined) return have.winget ? `winget install --id ${item.winget} -e` : null
  if (item.npm !== undefined) return have.npm ? `npm install -g ${item.npm}` : null
  return null
}

function found(status: SetupStatus, id: SetupStatus['prerequisites'][number]['id']): boolean {
  return status.prerequisites.some(p => p.id === id && p.path !== null)
}

function tools(status: SetupStatus): { winget: boolean; npm: boolean } {
  return { winget: found(status, 'winget'), npm: found(status, 'npm') }
}

export interface ChecklistRow {
  id: InstallId
  name: string
  found: boolean
  optional: boolean
  why: string
  link: string
  command: string | null
}

/**
 * Step 1, prerequisites. Git counts only with its Bash (Claude Code's status
 * line), Node.js only with npm (the npm-installed agents).
 */
export function prerequisiteChecklist(status: SetupStatus): ChecklistRow[] {
  const have = tools(status)
  const row = (id: 'git' | 'node' | 'python', ok: boolean, optional: boolean): ChecklistRow => {
    const item = INSTALL_CATALOG[id]
    return { id, name: item.name, found: ok, optional, why: item.why, link: item.link, command: ok ? null : installCommand(item, have) }
  }
  return [
    row('git', found(status, 'git') && found(status, 'gitBash'), false),
    row('node', found(status, 'node') && found(status, 'npm'), false),
    row('python', found(status, 'python'), true)
  ]
}

export interface AgentRow {
  id: 'claude-code' | 'codex' | 'opencode'
  name: string
  installed: boolean
  why: string
  link: string
  command: string | null
  /** A one-time step inside the agent, if any. */
  note: string | null
}

/**
 * Step 1, agents. "Installed" means the backend probe found a CLI that
 * starts in a pane; an unknown probe (empty map) counts as not installed
 * here, unlike the optimistic pickers, because this list tells the user
 * what to install.
 */
export function agentChecklist(availability: AgentAvailabilityMap, status: SetupStatus): AgentRow[] {
  const have = tools(status)
  return (['claude-code', 'codex', 'opencode'] as const).map(id => {
    const item = INSTALL_CATALOG[id]
    const installed = availability[id] === true
    return {
      id,
      name: item.name,
      installed,
      why: item.why,
      link: item.link,
      command: installed ? null : installCommand(item, have),
      note: id === 'codex' ? 'In your first Codex pane, run /hooks once and trust Swarmterm\'s hooks.' : null
    }
  })
}

export interface KeyVarRow {
  name: string
  /** Panes get it with the current settings. */
  passed: boolean
  /** The administrator decides; the user cannot change it here. */
  locked: boolean
}

function allowMatches(list: readonly string[], name: string): boolean {
  const upper = name.toUpperCase()
  return list.some(entry => {
    const e = entry.trim().toUpperCase()
    return e.endsWith('*') ? upper.startsWith(e.slice(0, -1)) : e === upper
  })
}

/**
 * Step 2 (H4): the environment filter holds API key variables back by
 * default, so a CLI that should sign in by key needs its variable passed.
 * Mirrors `policy.rs::apply_env`: with an admin env policy the user's own
 * list is dropped and only the admin's names pass.
 */
export function keyVarRows(names: readonly string[], user: EnvPolicy, admin: AdminPolicy): KeyVarRow[] {
  const managed = admin.envPolicy !== null
  return names.map(name => {
    const byAdmin = allowMatches(admin.envAllow, name)
    const passed = managed ? byAdmin : user.passSecrets || byAdmin || allowMatches(user.allow, name)
    return { name, passed, locked: managed }
  })
}

/** The user's policy with `name` on the "always pass" list (names only, never a value). */
export function passKeyVar(policy: EnvPolicy, name: string): EnvPolicy {
  if (allowMatches(policy.allow, name)) return policy
  return { ...policy, allow: [...policy.allow, name] }
}

export type VoiceChoice = 'off' | 'buzzkey' | 'builtin'

export interface VoiceOption {
  id: VoiceChoice
  label: string
  text: string
}

/**
 * D3: off is the default for a new install. Built-in dictation needs a
 * model download, which Corp builds and `DisableModelDownload` lack; with
 * the companion locked buzzkey still works, but not from our installer.
 */
export function voiceChoices(can: { modelDownload: boolean; companion: boolean }): VoiceOption[] {
  const all: VoiceOption[] = [
    { id: 'off', label: 'Off', text: 'No dictation. You can switch it on later in Settings → Voice.' },
    {
      id: 'buzzkey',
      label: 'buzzkey',
      text: can.companion
        ? 'Dictate with the separate buzzkey app. Install it from Settings → Voice.'
        : 'Dictate with the separate buzzkey app, if your organisation provides it.'
    },
    { id: 'builtin', label: 'Built-in', text: 'Swarmterm transcribes on this PC. Download a speech model in Settings → Voice.' }
  ]
  return can.modelDownload ? all : all.filter(o => o.id !== 'builtin')
}

export function applyVoiceChoice(settings: VoiceSettings, choice: VoiceChoice): VoiceSettings {
  return { ...settings, enabled: choice !== 'off', builtinEnabled: choice === 'builtin' }
}

/**
 * Step 4: agents whose CLI the probe confirmed (an unknown probe offers
 * none, so the first workspace never opens on a pane that cannot start),
 * plus the plain terminal last.
 */
export function startableAgents(availability: AgentAvailabilityMap): WorkspaceTemplate[] {
  const agents = TEMPLATES.filter(t => t.executable !== undefined && availability[t.id] === true)
  return [...agents, ...TEMPLATES.filter(t => t.id === DEFAULT_TEMPLATE_ID)]
}

export function workspaceFolderProblem(folder: string, home: string | null): 'empty' | 'broad' | null {
  if (folder.trim() === '') return 'empty'
  return isBroadFolder(folder, home) ? 'broad' : null
}

export function wizardAgentIds(count: number, agentId: string): string[] {
  return Array.from({ length: count }, () => agentId)
}

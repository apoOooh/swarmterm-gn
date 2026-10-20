/**
 * Workspace templates offered by the setup wizard. A template decides the
 * command each terminal runs once on first spawn (`null` means a plain shell).
 */

import ampIcon from '@/assets/agents/amp.svg'
import antigravityIcon from '@/assets/agents/antigravity.svg'
import claudeIcon from '@/assets/agents/claude-code.svg'
import codexIcon from '@/assets/agents/codex.svg'
import copilotIcon from '@/assets/agents/copilot.svg'
import cursorIcon from '@/assets/agents/cursor.svg'
import geminiIcon from '@/assets/agents/gemini.svg'
import ompIcon from '@/assets/agents/omp.svg'
import opencodeIcon from '@/assets/agents/opencode.svg'
import qwenIcon from '@/assets/agents/qwen.svg'
import type { ContinueHow } from '@/lib/layout-tree'

/** Session ids come from on-disk stores owned by other programs and end up
 *  typed into a live shell line — each pattern is an allow-list of the exact
 *  shape that CLI emits, not a sanity check. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// OpenCode: "ses_" + 12 hex + 14 base62 today; ranged so a minor format bump
// doesn't silently kill the feature, while still shell-safe ([A-Za-z0-9] only).
const OPENCODE_RE = /^ses_[A-Za-z0-9]{10,40}$/
// OMP ids are unverified (no store scanner yet); conservative shell-safe
// allow-list, leading char alphanumeric so the value can never read as a flag.
const OMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/

/** Which backend store scanner (src-tauri/src/sessions/) feeds the composer's
 *  "Resume sessions" list for this agent. The Rust side mirrors these tags. */
export type SessionScannerKind = 'claude-jsonl' | 'codex-rollout' | 'opencode-cli' | 'qwen-chats'

export interface TemplateResume {
  /** Exact session-id shape this CLI emits. */
  idPattern: RegExp
  /** One-line resume command, built on the template's base command so flag
   *  changes (e.g. the claude permissions flag) carry over automatically. */
  buildCommand: (base: string, sessionId: string) => string
}

/** One way to launch an agent CLI: the arguments appended to its command.
 *  Swapping a CLI-native mode flag in later only touches this table. */
export interface LaunchMode {
  id: string
  label: string
  args: string
}

export interface WorkspaceTemplate {
  id: string
  name: string
  description: string
  /** Command run when each terminal first spawns, or `null` for a plain shell. */
  command: string | null
  /** Executable probed by the backend to decide availability; `undefined` ⇒ always available. */
  executable?: string
  /** Brand logo URL for the agent, or `undefined` for the plain terminal. */
  icon?: string
  /** Resume support (L2): absent ⇒ the CLI cannot resume a session by id. */
  resume?: TemplateResume
  /** Store scanner feeding "Resume sessions"; absent ⇒ the agent has no
   *  scanner yet and never appears in that list (fail-open by construction). */
  sessionScanner?: SessionScannerKind
  /** Flag that makes the CLI run a startup prompt and STAY interactive
   *  (worktree.spawn briefs). Absent ⇒ the prompt is passed positionally —
   *  verified fine for claude/codex, but gemini-heritage CLIs treat a
   *  positional prompt as one-shot and exit. */
  spawnPromptFlag?: string
  /** Swarmterm connects this CLI to its MCP server itself (config file or,
   *  for OpenCode, per-pane env). Everything else gets the manual hint. */
  mcpAutoEnrolled?: boolean
  /** Selectable launch modes; the first entry is the default. Absent ⇒ the
   *  command runs as-is. A mode switch respawns the pane with the new args. */
  launchModes?: LaunchMode[]
  /** Command that continues a session: the latest one ('last', mode switch
   *  without a known id) or one picked in the CLI ('pick'). Absent ⇒ a mode
   *  switch starts a fresh session and no picker is offered. */
  continueCommand?: (base: string, how: ContinueHow) => string
}

export const TEMPLATES: WorkspaceTemplate[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's coding agent.",
    command: 'claude',
    executable: 'claude',
    icon: claudeIcon,
    // Permission mode is never restored on resume — the mode args must ride
    // again, which withLaunchMode on every spawn form guarantees.
    resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --resume ${id}` },
    sessionScanner: 'claude-jsonl',
    mcpAutoEnrolled: true,
    // Bypass keeps the dedicated flag: `--permission-mode bypassPermissions`
    // is refused unless bypass was enabled in Claude's own settings.
    launchModes: [
      { id: 'default', label: 'Default', args: '--permission-mode default' },
      { id: 'acceptEdits', label: 'Accept edits', args: '--permission-mode acceptEdits' },
      { id: 'plan', label: 'Plan', args: '--permission-mode plan' },
      { id: 'auto', label: 'Auto', args: '--permission-mode auto' },
      { id: 'bypass', label: 'Bypass permissions', args: '--dangerously-skip-permissions' }
    ],
    // --continue is scoped to the pane's cwd by claude itself; bare --resume
    // opens its session picker.
    continueCommand: (base, how) => (how === 'pick' ? `${base} --resume` : `${base} --continue`)
  },
  {
    id: 'codex',
    name: 'Codex',
    description: "OpenAI's Codex CLI.",
    command: 'codex',
    executable: 'codex',
    icon: codexIcon,
    // `codex resume <id>` is a subcommand, not a flag.
    resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} resume ${id}` },
    sessionScanner: 'codex-rollout',
    mcpAutoEnrolled: true,
    // Codex has no plan/mode CLI flag yet (Plan stays /plan in the session);
    // the modes map onto sandbox + approval flags, accepted by `resume` too.
    launchModes: [
      { id: 'auto', label: 'Auto', args: '-s workspace-write -a on-request' },
      { id: 'safe', label: 'Safe (read-only)', args: '-s read-only -a on-request' },
      { id: 'yolo', label: 'YOLO', args: '--dangerously-bypass-approvals-and-sandbox' }
    ],
    // --last is filtered to the pane's cwd by codex itself.
    continueCommand: (base, how) => (how === 'pick' ? `${base} resume` : `${base} resume --last`)
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Open-source terminal coding agent.',
    command: 'opencode',
    executable: 'opencode',
    icon: opencodeIcon,
    resume: { idPattern: OPENCODE_RE, buildCommand: (base, id) => `${base} --session ${id}` },
    sessionScanner: 'opencode-cli',
    // Per pane via OPENCODE_CONFIG_CONTENT (pty.rs), no config file written.
    mcpAutoEnrolled: true
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    description: "GitHub's Copilot CLI.",
    command: 'copilot',
    executable: 'copilot',
    icon: copilotIcon,
    // Resume flag from herdr's table (--resume=<id>, equals form); ids are
    // UUIDs. No store scanner yet, so the composer list never offers these —
    // the rule is dormant until a scanner lands.
    resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --resume=${id}` }
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: "Alibaba's Qwen Code CLI.",
    command: 'qwen',
    executable: 'qwen',
    icon: qwenIcon,
    resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --resume ${id}` },
    sessionScanner: 'qwen-chats',
    // -i / --prompt-interactive: run the brief, stay interactive (a
    // positional prompt would run one-shot and exit).
    spawnPromptFlag: '-i',
    mcpAutoEnrolled: true
  },
  {
    id: 'amp',
    name: 'Amp',
    description: "Sourcegraph's Amp coding agent.",
    command: 'amp',
    executable: 'amp',
    icon: ampIcon
    // No resume: the CLI has no resume-by-id flag (herdr has none either).
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: "Google's Gemini CLI.",
    command: 'gemini',
    executable: 'gemini',
    icon: geminiIcon,
    // No resume: gemini has no resume-by-id flag (herdr has none either).
    spawnPromptFlag: '-i'
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    description: "Cursor's CLI agent.",
    // The bare name also resolves cursor-agent.cmd on Windows via PATHEXT,
    // both in the probe (agents.rs candidates) and in the spawned shell line.
    command: 'cursor-agent',
    executable: 'cursor-agent',
    icon: cursorIcon,
    resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --resume ${id}` }
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    description: "Google's Antigravity agent CLI.",
    command: 'agy',
    executable: 'agy',
    icon: antigravityIcon,
    resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --conversation ${id}` }
  },
  {
    id: 'omp',
    name: 'OMP (Oh My Pi)',
    description: 'Community fork of the Pi coding agent.',
    command: 'omp',
    executable: 'omp',
    icon: ompIcon,
    resume: { idPattern: OMP_ID_RE, buildCommand: (base, id) => `${base} --resume=${id}` }
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'A plain shell — runs no command.',
    command: null
  }
]

export const DEFAULT_TEMPLATE_ID = 'terminal'

/**
 * Perf harness only (scripts/perf/flood.ps1 `-MockAgents`, scenario e): a
 * pseudo agent whose command is the local synthetic generator
 * `agent-stream.mjs` (copied into the perf data dir, the pane's cwd). It runs
 * no AI provider and no agent CLI, so the agent detector, tab badges and War
 * Room state flips can be measured without usage. Deliberately NOT in
 * TEMPLATES (never offered in any picker) and resolved only in dev builds;
 * a release build maps the id to the plain terminal like any unknown id.
 */
export const PERF_MOCK_AGENT_ID = 'perf-mock-agent'
export const PERF_MOCK_AGENT_COMMAND = 'node agent-stream.mjs --mock'
// Frozen and carrying only `command`: no executable, launch modes, resume,
// continue or prompt flags, so nothing can append arguments or swap in a real
// CLI, and nothing at runtime can mutate it into one.
const PERF_MOCK_TEMPLATE: WorkspaceTemplate = Object.freeze({
  id: PERF_MOCK_AGENT_ID,
  name: 'Perf mock agent',
  description: 'Synthetic agent output for the perf harness (no AI).',
  command: PERF_MOCK_AGENT_COMMAND
})
const perfMockEnabled = (): boolean => import.meta.env.DEV === true

/** The template with `id`, or the default template when `id` is unknown. */
export function templateById(id: string): WorkspaceTemplate {
  if (id === PERF_MOCK_AGENT_ID && perfMockEnabled()) return PERF_MOCK_TEMPLATE
  return (
    TEMPLATES.find((t) => t.id === id) ??
    TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID) ??
    TEMPLATES[0]
  )
}

/** The startup command for an agent id, or `undefined` for a plain shell. */
export function agentCommand(agentId: string | undefined): string | undefined {
  return templateById(agentId ?? DEFAULT_TEMPLATE_ID).command ?? undefined
}

/** The launch mode `modeId` of an agent, falling back to its default (first)
 *  mode; `undefined` when the agent has no modes. */
export function launchMode(agentId: string | undefined, modeId: string | undefined): LaunchMode | undefined {
  const modes = templateById(agentId ?? DEFAULT_TEMPLATE_ID).launchModes
  if (modes === undefined || modes.length === 0) return undefined
  return modes.find((m) => m.id === modeId) ?? modes[0]
}

/** `command` with the launch-mode args appended (unchanged without modes). */
export function withLaunchMode(command: string, agentId: string | undefined, modeId: string | undefined): string {
  const mode = launchMode(agentId, modeId)
  return mode === undefined || mode.args === '' ? command : `${command} ${mode.args}`
}

/**
 * True only when the template runs NO command — the pane is the user's own
 * shell. Deliberately NOT "has no detection manifest" (`manifestForAgent`):
 * `omp` ships without a manifest yet runs `omp`, so a gate keyed on the
 * manifest would treat its hour-long run as a plain-shell command (Git-panel
 * refresh + "Command finished" chime for an agent session). Exact lookup on
 * purpose — `templateById`'s unknown-id fallback to `terminal` would read a
 * typo as a plain shell, the opposite of fail-closed.
 */
export function isPlainShellPane(agentId: string | undefined): boolean {
  if (agentId === PERF_MOCK_AGENT_ID && perfMockEnabled()) return false
  return TEMPLATES.find((t) => t.id === agentId)?.command === null
}

/**
 * Template id → installed?, from the backend probe (`list_available_agents`).
 * A missing id reads as installed — optimistic, so a pending or failed probe
 * never locks out a working CLI.
 */
export type AgentAvailabilityMap = Record<string, boolean>

/** Whether a template's CLI is installed. Templates with no executable (plain
 *  Terminal) are always available. */
export function isTemplateAvailable(
  template: WorkspaceTemplate,
  availability: AgentAvailabilityMap
): boolean {
  if (!template.executable) return true
  return availability[template.id] !== false
}

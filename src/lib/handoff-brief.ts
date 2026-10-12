/**
 * Handoff brief (SWA-21): a plain-text summary of one pane that another agent
 * (or a human) can pick the work up from. Pure on purpose — the dialog gathers
 * the inputs, this module only renders them, so SWA-22 can reuse the very same
 * text as the first prompt of a new pane without a DOM or a pty.
 *
 * Provenance is the core rule. The terminal can prove almost nothing about the
 * work: scrollback is truncated, redrawn by TUIs and says nothing about intent.
 * So task, status, open items and tests are always labelled as "stated by the
 * user", never as derived from the terminal, and the optional raw excerpt is
 * explicitly marked incomplete. Only facts read from a source of truth (git,
 * the pane's own config) appear unqualified.
 *
 * Nothing here sends anything. Delivery (SWA-22) must go through
 * `deliverPromptToTerminal` + `submitTerminalPrompt` and the War Room
 * scheduler's typing hold, like every other renderer-authored prompt; it is not
 * a notification-center event (no agent-state transition is involved), so it
 * must not be published as one.
 */

/** Facts about the pane, read from config or git — the only unqualified part. */
export interface HandoffContext {
  agentName: string
  accountLabel?: string
  cwd: string
  /** Observed CLI session id, if the agent reported one. */
  sessionId?: string
  /** Absent when the cwd is not a git repo or the lookup failed. */
  git?: HandoffGit
}

export interface HandoffGit {
  branch: string
  headSha: string
  ahead: number | null
  behind: number | null
  /** Uncommitted changes relative to HEAD, as `git status` reports them. */
  changedFiles: Array<{ path: string; status: string; added: number; removed: number }>
}

/** What the user writes in the dialog. Empty fields render as "not stated". */
export interface HandoffDraft {
  task: string
  status: string
  openItems: string
  tests: string
}

export interface HandoffOptions {
  /** Raw tail of the terminal buffer; omitted unless the user opted in. */
  terminalExcerpt?: string
}

export const EMPTY_DRAFT: HandoffDraft = { task: '', status: '', openItems: '', tests: '' }

/** Hard cap so a huge scrollback cannot turn the brief into a log dump. */
export const MAX_EXCERPT_LINES = 60

const NOT_STATED = '(not stated)'
const USER_STATED = '_Stated by the user, not verified from terminal output._'

function section(title: string, body: string, note?: string): string {
  const text = body.trim() === '' ? NOT_STATED : body.trim()
  return [`## ${title}`, ...(note ? [note] : []), text].join('\n')
}

/** Last MAX_EXCERPT_LINES non-trailing-blank lines, with any stray escape sequences removed. */
export function trimExcerpt(raw: string, maxLines = MAX_EXCERPT_LINES): { text: string; truncated: boolean } {
  // readTerminalText already yields plain text, but SWA-22 pastes this into a
  // TUI: a stray ESC must never survive into the brief.
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  const lines = clean.replace(/\s+$/, '').split('\n')
  if (lines.length <= maxLines) return { text: lines.join('\n'), truncated: false }
  return { text: lines.slice(-maxLines).join('\n'), truncated: true }
}

function contextSection(ctx: HandoffContext): string {
  const lines = [
    `- Agent: ${ctx.agentName}`,
    `- Account: ${ctx.accountLabel ?? 'default'}`,
    `- Working directory: ${ctx.cwd}`,
    `- Session: ${ctx.sessionId ?? 'unknown'}`
  ]
  return ['## Context', ...lines].join('\n')
}

function gitSection(git: HandoffGit | undefined): string {
  if (!git) return ['## Git', 'Not a git repository, or git state was unavailable.'].join('\n')
  const tracking =
    git.ahead === null || git.behind === null ? 'no upstream' : `${git.ahead} ahead, ${git.behind} behind upstream`
  const lines = [`- Branch: ${git.branch || '(detached)'}`, `- HEAD: ${git.headSha}`, `- Tracking: ${tracking}`]
  if (git.changedFiles.length === 0) {
    lines.push('- Working tree: clean (no diff against HEAD)')
  } else {
    // A reference, not the diff itself: the receiver reads the real diff from
    // the repo, which stays correct even if the brief is edited or delayed.
    lines.push(`- Diff reference: \`git diff ${git.headSha}\` (${git.changedFiles.length} changed files)`)
    for (const f of git.changedFiles) lines.push(`  - ${f.status} ${f.path} (+${f.added} -${f.removed})`)
  }
  return ['## Git', ...lines].join('\n')
}

/** Render the brief as Markdown — the text the preview edits and SWA-22 sends. */
export function buildHandoffBrief(ctx: HandoffContext, draft: HandoffDraft, opts: HandoffOptions = {}): string {
  const parts = [
    '# Handoff brief',
    section('Task', draft.task, USER_STATED),
    section('Status', draft.status, USER_STATED),
    section('Open items', draft.openItems, USER_STATED),
    section('Tests', draft.tests, USER_STATED),
    contextSection(ctx),
    gitSection(ctx.git)
  ]
  if (opts.terminalExcerpt !== undefined && opts.terminalExcerpt.trim() !== '') {
    const { text, truncated } = trimExcerpt(opts.terminalExcerpt)
    parts.push(
      [
        '## Terminal excerpt (incomplete)',
        `_Raw tail of the pane's scrollback${truncated ? `, cut to the last ${MAX_EXCERPT_LINES} lines` : ''}. ` +
          'Incomplete and unverified — it proves neither the task nor test results._',
        '```text',
        text.replace(/```/g, "'''"),
        '```'
      ].join('\n')
    )
  }
  return parts.join('\n\n') + '\n'
}

/** Folder a brief/handoff is about: the shell's live cwd (the user may have
 *  `cd`'d since the pane started), else the configured one. Captured once when
 *  the dialog opens so Git data and the new pane agree. */
export function handoffCwd(live: string | undefined, configured: string): string {
  const dir = live?.trim()
  return dir ? dir : configured
}

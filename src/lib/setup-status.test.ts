import { describe, expect, it } from 'vitest'
import {
  SETUP_ALERT_ID,
  codexHookHint,
  gitBashHint,
  prerequisiteRows,
  worktreeOptionNote,
  gitInstalled,
  GIT_INSTALL_COMMAND,
  defaultWelcomeFolder,
  isBroadFolder,
  nextSetupBellAction,
  setupBellEntry,
  setupProblems,
  setupRows,
  type SetupCheck,
  type SetupStatus
} from './setup-status'

const ok: SetupCheck = { state: 'ok', detail: null }
const check = (state: SetupCheck['state'], detail: string | null = null): SetupCheck => ({ state, detail })

function status(over: Partial<{ claude: Partial<SetupStatus['claude']>; codex: Partial<SetupStatus['codex']> }> = {}): SetupStatus {
  return {
    claude: { installed: true, gitBash: 'C:/Program Files/Git/bin/bash.exe', hooks: ok, mcp: ok, statusLine: ok, ...over.claude },
    codex: { installed: true, hooks: ok, mcp: ok, ...over.codex },
    prerequisites: []
  }
}

describe('setupRows', () => {
  it('lists every integration per agent in a fixed order', () => {
    expect(setupRows(status()).map(r => r.id)).toEqual([
      'claude.hooks', 'claude.mcp', 'claude.statusLine', 'codex.hooks', 'codex.mcp'
    ])
  })

  it('maps states to tones and plain sentences', () => {
    const rows = setupRows(status({
      claude: { hooks: check('notInstalled'), statusLine: check('foreign') },
      codex: { hooks: check('outdated'), mcp: check('error', 'parse: bad toml') }
    }))
    const by = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(by['claude.hooks']).toMatchObject({ tone: 'muted', text: 'Not installed — nothing was written' })
    expect(by['claude.mcp']).toMatchObject({ tone: 'ok' })
    expect(by['claude.statusLine']).toMatchObject({ tone: 'muted', text: 'Your own status line is kept' })
    expect(by['codex.hooks']).toMatchObject({ tone: 'warn' })
    expect(by['codex.hooks'].text).toMatch(/update codex/i)
    expect(by['codex.mcp']).toMatchObject({ tone: 'error', detail: 'parse: bad toml' })
  })

  it('never shows a raw state name', () => {
    const states: SetupCheck['state'][] = ['unknown', 'ok', 'off', 'notInstalled', 'outdated', 'foreign', 'deferred', 'needsGitBash', 'error']
    for (const s of states) {
      for (const row of setupRows(status({ claude: { hooks: check(s) } }))) {
        expect(row.text).not.toMatch(/^(unknown|notInstalled|deferred)$/)
        expect(row.text.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('Git Bash missing', () => {
  const missing = status({ claude: { gitBash: null, hooks: check('needsGitBash'), statusLine: check('needsGitBash') } })

  it('is a warning in Settings, not a bell problem', () => {
    const by = Object.fromEntries(setupRows(missing).map(r => [r.id, r]))
    expect(by['claude.hooks']).toMatchObject({ tone: 'warn' })
    expect(by['claude.hooks'].text).toMatch(/git bash/i)
    expect(by['claude.mcp']).toMatchObject({ tone: 'ok' })
    expect(setupBellEntry(missing, 1)).toBeNull()
  })

  it('explains what to do with a link and a command to copy, never runs it', () => {
    const hint = gitBashHint(missing)
    expect(hint).not.toBeNull()
    expect(hint?.command).toBe(GIT_INSTALL_COMMAND)
    expect(GIT_INSTALL_COMMAND).toMatch(/^winget install .*Git\.Git/)
    expect(hint?.link).toMatch(/^https:\/\/git-scm\.com\//)
    expect(hint?.text).toMatch(/check again/i)
  })

  it('names only what still needs it: with a current Claude Code that is the status line', () => {
    const lineOnly = status({ claude: { gitBash: null, hooks: check('ok'), statusLine: check('needsGitBash') } })
    expect(gitBashHint(lineOnly)?.text).toMatch(/status line through Git Bash/)
    expect(gitBashHint(lineOnly)?.text).not.toMatch(/hooks/)
    expect(gitBashHint(missing)?.text).toMatch(/hooks and status line/)
  })

  it('stays quiet while Git Bash is there or nothing needs it', () => {
    expect(gitBashHint(status())).toBeNull()
    expect(gitBashHint(status({ claude: { gitBash: null, hooks: check('notInstalled') } }))).toBeNull()
  })
})

describe('prerequisiteRows', () => {
  it('shows where a tool was found, or why a missing one matters', () => {
    const rows = prerequisiteRows({
      ...status(),
      prerequisites: [
        { id: 'git', path: 'C:/Program Files/Git/cmd/git.exe' },
        { id: 'gitBash', path: null },
        { id: 'python', path: null }
      ]
    })
    expect(rows.map(r => [r.name, r.found])).toEqual([['Git', true], ['Git Bash', false], ['Python', false]])
    expect(rows[0].text).toBe('C:/Program Files/Git/cmd/git.exe')
    expect(rows[1].text).toMatch(/claude code needs it/i)
    expect(rows[2].text).toMatch(/optional/i)
  })
})

describe('worktree option in Welcome', () => {
  const withGit = (path: string | null): SetupStatus => ({ ...status(), prerequisites: [{ id: 'git', path }] })

  it('knows whether git is installed once the prerequisites were scanned', () => {
    expect(gitInstalled(null)).toBeNull()
    expect(gitInstalled(status())).toBeNull()
    expect(gitInstalled(withGit('C:/Git/cmd/git.exe'))).toBe(true)
    expect(gitInstalled(withGit(null))).toBe(false)
  })

  it('says why the option is unavailable or what Create will do', () => {
    expect(worktreeOptionNote({ git: false, isGitRepo: false })).toMatch(/git is not installed/i)
    expect(worktreeOptionNote({ git: null, isGitRepo: false })).toMatch(/initialize git/i)
    expect(worktreeOptionNote({ git: true, isGitRepo: true })).toBeNull()
  })
})

describe('setupProblems / setupBellEntry', () => {
  it('only errors are problems; not installed, foreign, off and outdated are not', () => {
    const s = status({
      claude: { hooks: check('notInstalled'), statusLine: check('foreign'), mcp: check('off') },
      codex: { hooks: check('outdated') }
    })
    expect(setupProblems(s)).toEqual([])
    expect(setupBellEntry(s, 1)).toBeNull()
  })

  it('one bell entry names the first problem and counts the rest', () => {
    const s = status({
      claude: { hooks: check('error', 'parse: expected value') },
      codex: { mcp: check('error', 'rename: denied') }
    })
    expect(setupBellEntry(s, 7)).toEqual({
      kind: 'backend',
      terminalId: SETUP_ALERT_ID,
      title: 'Agent setup needs attention',
      detail: 'Claude Code hooks: parse: expected value (+1 more, see Settings → Setup)',
      at: 7
    })
  })

  it('a single problem has no count', () => {
    const s = status({ claude: { mcp: check('error', 'x') } })
    expect(setupBellEntry(s, 1)?.detail).toBe('Claude Code MCP entry: x (see Settings → Setup)')
  })

  it('the bell gets one entry per distinct problem and is marked read when it is gone', () => {
    const broken = status({ claude: { hooks: check('error', 'parse') } })
    const first = nextSetupBellAction(null, broken, 1)
    expect(first.type).toBe('add')
    expect(first.lastDetail).toBe(first.type === 'add' ? first.entry.detail : 'unreachable')
    // Same problem again (pane spawn, recheck): nothing new.
    expect(nextSetupBellAction(first.lastDetail, broken, 2)).toEqual({ type: 'none', lastDetail: first.lastDetail })
    // A different problem: a new entry.
    const other = nextSetupBellAction(first.lastDetail, status({ codex: { mcp: check('error', 'denied') } }), 3)
    expect(other.type).toBe('add')
    // Fixed: mark read once, then nothing.
    const fixed = nextSetupBellAction(other.lastDetail, status(), 4)
    expect(fixed).toEqual({ type: 'markRead', lastDetail: null })
    expect(nextSetupBellAction(null, status(), 5)).toEqual({ type: 'none', lastDetail: null })
  })
})

describe('codexHookHint', () => {
  it('stays quiet unless Codex panes are about to start', () => {
    expect(codexHookHint({ codexAvailable: true, sessionHooks: true, codexCount: 0 })).toBeNull()
    expect(codexHookHint({ codexAvailable: false, sessionHooks: true, codexCount: 2 })).toBeNull()
  })

  it('explains the one-time trust step for a supporting Codex', () => {
    expect(codexHookHint({ codexAvailable: true, sessionHooks: true, codexCount: 1 })).toMatch(/\/hooks/)
  })

  it('asks for an update when Codex has no session hooks', () => {
    expect(codexHookHint({ codexAvailable: true, sessionHooks: false, codexCount: 1 })).toMatch(/update codex/i)
  })
})

describe('welcome folder default', () => {
  const home = 'C:\\Users\\me'

  it('prefers the template folder, then the newest recent, never the home folder', () => {
    expect(defaultWelcomeFolder(' D:\\proj ', ['D:\\other'], home)).toBe('D:\\proj')
    expect(defaultWelcomeFolder('', ['D:\\other', 'D:\\older'], home)).toBe('D:\\other')
    expect(defaultWelcomeFolder('', [], home)).toBe('')
    expect(defaultWelcomeFolder('', [home, 'D:\\b'], home)).toBe('D:\\b')
    expect(defaultWelcomeFolder('', ['C:\\'], home)).toBe('')
  })

  it('flags the home folder and drive roots as too broad', () => {
    expect(isBroadFolder(home, home)).toBe(true)
    expect(isBroadFolder('c:\\users\\ME\\', home)).toBe(true)
    expect(isBroadFolder('D:\\', home)).toBe(true)
    expect(isBroadFolder('D:', home)).toBe(true)
    expect(isBroadFolder('D:\\proj', home)).toBe(false)
    expect(isBroadFolder('C:\\Users\\me\\proj', home)).toBe(false)
    expect(isBroadFolder('', home)).toBe(false)
    expect(isBroadFolder('D:\\proj', null)).toBe(false)
  })
})

describe('broad folder spellings', () => {
  it('ignores slash direction and trailing separators', () => {
    expect(isBroadFolder('C:/Users/dev', 'C:\\Users\\dev')).toBe(true)
    expect(isBroadFolder('c:/users/dev/', 'C:\\Users\\dev')).toBe(true)
    expect(isBroadFolder('D:/', null)).toBe(true)
    expect(isBroadFolder('D:/proj', 'C:\\Users\\dev')).toBe(false)
  })

  it('flags a bare UNC share root, not a folder inside it', () => {
    expect(isBroadFolder('\\\\server\\share', null)).toBe(true)
    expect(isBroadFolder('//server/share/', null)).toBe(true)
    expect(isBroadFolder('\\\\server\\share\\proj', null)).toBe(false)
  })
})

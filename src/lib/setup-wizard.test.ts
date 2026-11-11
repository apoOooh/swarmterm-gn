import { describe, expect, it } from 'vitest'
import {
  WIZARD_LAYOUTS,
  WIZARD_STEPS,
  agentChecklist,
  applyVoiceChoice,
  installCommand,
  INSTALL_CATALOG,
  keyVarRows,
  passKeyVar,
  prerequisiteChecklist,
  startableAgents,
  voiceChoices,
  wizardAgentIds,
  workspaceFolderProblem
} from './setup-wizard'
import type { SetupStatus } from './setup-status'
import { DEFAULT_ENV_POLICY } from './env-policy'
import { UNMANAGED_POLICY } from './policy'

const check = (state: SetupStatus['claude']['hooks']['state']) => ({ state, detail: null })

function status(found: Partial<Record<'git' | 'gitBash' | 'winget' | 'node' | 'npm' | 'python', boolean>> = {}): SetupStatus {
  const ids = ['git', 'gitBash', 'winget', 'node', 'npm', 'python'] as const
  return {
    claude: { installed: true, gitBash: found.gitBash === false ? null : 'C:/Git/bin/bash.exe', hooks: check('ok'), mcp: check('ok'), statusLine: check('ok') },
    codex: { installed: false, hooks: check('notInstalled'), mcp: check('notInstalled') },
    prerequisites: ids.map(id => ({ id, path: found[id] === false ? null : `C:/bin/${id}.exe` }))
  }
}

describe('steps', () => {
  it('has four steps in order', () => {
    expect(WIZARD_STEPS).toEqual(['prerequisites', 'signin', 'statusline', 'voice', 'workspace'])
    expect(WIZARD_LAYOUTS).toEqual([1, 2, 4])
  })
})

describe('installCommand (D6: shown to copy, never run)', () => {
  it('uses winget only when winget is there, else only the link', () => {
    expect(installCommand(INSTALL_CATALOG.git, { winget: true, npm: true })).toBe('winget install --id Git.Git -e')
    expect(installCommand(INSTALL_CATALOG.git, { winget: false, npm: true })).toBeNull()
    expect(installCommand(INSTALL_CATALOG['claude-code'], { winget: true, npm: false })).toBe('winget install --id Anthropic.ClaudeCode -e')
    expect(installCommand(INSTALL_CATALOG.node, { winget: true, npm: false })).toBe('winget install --id OpenJS.NodeJS.LTS -e')
  })

  it('takes npm for Codex and OpenCode, and nothing while npm is missing', () => {
    expect(installCommand(INSTALL_CATALOG.codex, { winget: true, npm: true })).toBe('npm install -g @openai/codex')
    expect(installCommand(INSTALL_CATALOG.opencode, { winget: false, npm: true })).toBe('npm install -g opencode-ai')
    expect(installCommand(INSTALL_CATALOG.codex, { winget: true, npm: false })).toBeNull()
  })

  it('links only to the vendors over https', () => {
    for (const item of Object.values(INSTALL_CATALOG)) expect(item.link).toMatch(/^https:\/\//)
  })
})

describe('prerequisiteChecklist', () => {
  it('lists Git, Node.js and the optional Python with what to do when missing', () => {
    const rows = prerequisiteChecklist(status({ git: false, gitBash: false, node: false, npm: false, python: false }))
    expect(rows.map(r => r.id)).toEqual(['git', 'node', 'python'])
    const git = rows.find(r => r.id === 'git')!
    expect(git).toMatchObject({ found: false, optional: false, command: 'winget install --id Git.Git -e' })
    expect(rows.find(r => r.id === 'python')!.optional).toBe(true)
  })

  it('needs Git Bash too before Git counts as found', () => {
    expect(prerequisiteChecklist(status({ gitBash: false })).find(r => r.id === 'git')!.found).toBe(false)
    expect(prerequisiteChecklist(status()).find(r => r.id === 'git')!.found).toBe(true)
  })

  it('needs npm too before Node.js counts as found', () => {
    expect(prerequisiteChecklist(status({ npm: false })).find(r => r.id === 'node')!.found).toBe(false)
  })

  it('drops the command without winget (LTSC, Server)', () => {
    const rows = prerequisiteChecklist(status({ git: false, winget: false }))
    expect(rows.find(r => r.id === 'git')!.command).toBeNull()
  })
})

describe('agentChecklist', () => {
  it('shows the three main agents, installed from the availability probe', () => {
    const rows = agentChecklist({ 'claude-code': true, codex: false, opencode: false }, status())
    expect(rows.map(r => r.id)).toEqual(['claude-code', 'codex', 'opencode'])
    expect(rows[0]).toMatchObject({ installed: true, command: null })
    expect(rows[1]).toMatchObject({ installed: false, command: 'npm install -g @openai/codex' })
  })

  it('tells Codex users to trust the hooks once', () => {
    const codex = agentChecklist({ codex: true }, status()).find(r => r.id === 'codex')!
    expect(codex.note).toMatch(/\/hooks/)
  })

  it('treats an unknown probe as not installed in the checklist', () => {
    expect(agentChecklist({}, status()).every(r => !r.installed)).toBe(true)
  })
})

describe('sign-in by API key (H4)', () => {
  it('reports each set variable as held back by the filter until passed', () => {
    const rows = keyVarRows(['ANTHROPIC_API_KEY'], DEFAULT_ENV_POLICY, UNMANAGED_POLICY)
    expect(rows).toEqual([{ name: 'ANTHROPIC_API_KEY', passed: false, locked: false }])
    const passed = passKeyVar(DEFAULT_ENV_POLICY, 'ANTHROPIC_API_KEY')
    expect(passed.allow).toEqual(['ANTHROPIC_API_KEY'])
    expect(passKeyVar(passed, 'anthropic_api_key').allow).toEqual(['ANTHROPIC_API_KEY'])
    expect(keyVarRows(['ANTHROPIC_API_KEY'], passed, UNMANAGED_POLICY)[0].passed).toBe(true)
  })

  it('counts "pass secrets" as passed', () => {
    expect(keyVarRows(['OPENAI_API_KEY'], { ...DEFAULT_ENV_POLICY, passSecrets: true }, UNMANAGED_POLICY)[0].passed).toBe(true)
  })

  it('respects the admin policy: locked unless the administrator allows the name', () => {
    const admin = { ...UNMANAGED_POLICY, envPolicy: 'default' as const, envAllow: ['OPENAI_API_KEY'] }
    const rows = keyVarRows(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], passKeyVar(DEFAULT_ENV_POLICY, 'ANTHROPIC_API_KEY'), admin)
    expect(rows).toEqual([
      { name: 'ANTHROPIC_API_KEY', passed: false, locked: true },
      { name: 'OPENAI_API_KEY', passed: true, locked: true }
    ])
  })
})

describe('voice step', () => {
  it('offers off, buzzkey and built-in; no built-in without a model download (Corp, policy)', () => {
    expect(voiceChoices({ modelDownload: true, companion: true }).map(c => c.id)).toEqual(['off', 'buzzkey', 'builtin'])
    expect(voiceChoices({ modelDownload: false, companion: true }).map(c => c.id)).toEqual(['off', 'buzzkey'])
  })

  it('does not point to the buzzkey install when the companion is locked', () => {
    const buzzkey = voiceChoices({ modelDownload: false, companion: false }).find(c => c.id === 'buzzkey')!
    expect(buzzkey.text).not.toMatch(/install/i)
  })

  it('maps a choice onto the settings without touching the rest', () => {
    const base = { enabled: false, allowAutoEnter: true, announceTurns: false, builtinEnabled: false, model: 'small-q5', language: 'auto', speakTurns: false, ttsVoice: '', ttsVolume: 80, allowExcerpts: false }
    expect(applyVoiceChoice(base, 'off')).toMatchObject({ enabled: false, builtinEnabled: false, allowAutoEnter: true })
    expect(applyVoiceChoice(base, 'buzzkey')).toMatchObject({ enabled: true, builtinEnabled: false })
    expect(applyVoiceChoice(base, 'builtin')).toMatchObject({ enabled: true, builtinEnabled: true })
  })
})

describe('workspace step', () => {
  it('offers only agents that start, and always the plain terminal last', () => {
    const ids = startableAgents({ 'claude-code': true, codex: false, opencode: true, copilot: false }).map(t => t.id)
    expect(ids[0]).toBe('claude-code')
    expect(ids).toContain('opencode')
    expect(ids).not.toContain('codex')
    expect(ids).not.toContain('copilot')
    expect(ids[ids.length - 1]).toBe('terminal')
  })

  it('does not offer agents the probe has not confirmed', () => {
    expect(startableAgents({}).map(t => t.id)).toEqual(['terminal'])
  })

  it('warns about an empty, home or drive-root folder', () => {
    expect(workspaceFolderProblem('', 'C:/Users/a')).toBe('empty')
    expect(workspaceFolderProblem('C:\\Users\\a', 'C:/Users/a')).toBe('broad')
    expect(workspaceFolderProblem('D:\\', null)).toBe('broad')
    expect(workspaceFolderProblem('D:/code/app', 'C:/Users/a')).toBeNull()
  })

  it('fills every pane with the chosen agent', () => {
    expect(wizardAgentIds(4, 'codex')).toEqual(['codex', 'codex', 'codex', 'codex'])
  })
})

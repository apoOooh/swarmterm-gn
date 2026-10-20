import { describe, it, expect } from 'vitest'
import {
  TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  templateById,
  agentCommand,
  isPlainShellPane,
  isTemplateAvailable,
  PERF_MOCK_AGENT_ID,
  PERF_MOCK_AGENT_COMMAND
} from './templates'
import { manifestForAgent } from '@/lib/agent-state/manifests'

describe('TEMPLATES catalog', () => {
  it('lists the AI agents first and the plain terminal last', () => {
    const ids = TEMPLATES.map((t) => t.id)
    expect(ids[ids.length - 1]).toBe('terminal')
    expect(ids).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'copilot',
      'qwen',
      'amp',
      'gemini',
      'cursor',
      'antigravity',
      'omp',
      'terminal'
    ])
  })

  it('gives every agent a non-empty launch command except the plain terminal', () => {
    for (const t of TEMPLATES) {
      if (t.id === 'terminal') expect(t.command).toBeNull()
      else expect(t.command).toBeTruthy()
    }
  })

  it('runs no command for the terminal agent', () => {
    expect(templateById('terminal').command).toBeNull()
  })

  it('runs the bare claude command (permission mode comes from launch modes)', () => {
    expect(templateById('claude-code').command).toBe('claude')
  })

  it('runs a plain codex command for codex', () => {
    expect(templateById('codex').command).toBe('codex')
  })

  it('runs the bare opencode CLI command', () => {
    expect(templateById('opencode').command).toBe('opencode')
  })
})

describe('agentCommand', () => {
  it('returns undefined for the default terminal agent', () => {
    expect(agentCommand('terminal')).toBeUndefined()
  })

  it('returns undefined when the agent id is undefined', () => {
    expect(agentCommand(undefined)).toBeUndefined()
  })

  it('returns the command string for a command agent', () => {
    expect(agentCommand('claude-code')).toBe('claude')
    expect(agentCommand('codex')).toBe('codex')
  })

  it('falls back to the default agent for an unknown id', () => {
    expect(agentCommand('nope')).toBeUndefined()
  })

  it('exposes terminal as the default agent id', () => {
    expect(DEFAULT_TEMPLATE_ID).toBe('terminal')
  })
})

describe('isPlainShellPane', () => {
  it('is true only for the template that runs no command', () => {
    expect(isPlainShellPane('terminal')).toBe(true)
    for (const t of TEMPLATES) expect(isPlainShellPane(t.id)).toBe(t.command === null)
  })

  it('is false for omp, which runs a command but ships no detection manifest', () => {
    // The whole reason this predicate exists: "no manifest" ≠ "plain shell".
    // Keying the OSC 133 gate on the manifest let an omp pane's own shell
    // report its hour-long `omp` run as a finished command.
    expect(isPlainShellPane('omp')).toBe(false)
  })

  it('fails closed on an unknown or missing id (no templateById fallback)', () => {
    expect(isPlainShellPane('nope')).toBe(false)
    expect(isPlainShellPane(undefined)).toBe(false)
  })
})

describe('resume catalog', () => {
  it('gives the three launch agents a resume rule and scanner tag', () => {
    for (const id of ['claude-code', 'codex', 'opencode']) {
      const t = templateById(id)
      expect(t.resume).toBeDefined()
      expect(t.sessionScanner).toBeDefined()
    }
    expect(templateById('terminal').resume).toBeUndefined()
    expect(templateById('terminal').sessionScanner).toBeUndefined()
  })
})

describe('MCP auto-enrollment flags', () => {
  it('marks exactly the CLIs Swarmterm connects automatically', () => {
    const enrolled = TEMPLATES.filter((t) => t.mcpAutoEnrolled === true).map((t) => t.id)
    expect(enrolled).toEqual(['claude-code', 'codex', 'opencode', 'qwen'])
  })
  it('gives gemini-heritage CLIs the stay-interactive prompt flag', () => {
    expect(templateById('qwen').spawnPromptFlag).toBe('-i')
    expect(templateById('gemini').spawnPromptFlag).toBe('-i')
    expect(templateById('claude-code').spawnPromptFlag).toBeUndefined()
  })
})

describe('isTemplateAvailable', () => {
  const claude = templateById('claude-code')
  const terminal = templateById('terminal')

  it('marks the AI agents with their executable names, terminal with none', () => {
    expect(templateById('claude-code').executable).toBe('claude')
    expect(templateById('codex').executable).toBe('codex')
    expect(templateById('opencode').executable).toBe('opencode')
    expect(templateById('terminal').executable).toBeUndefined()
  })

  it('treats templates without an executable as always available', () => {
    expect(isTemplateAvailable(terminal, {})).toBe(true)
    expect(isTemplateAvailable(terminal, { terminal: false })).toBe(true)
  })

  it('reads the availability map for executable-backed templates', () => {
    expect(isTemplateAvailable(claude, { 'claude-code': true })).toBe(true)
    expect(isTemplateAvailable(claude, { 'claude-code': false })).toBe(false)
  })

  it('is optimistic when the map has no entry (probe pending or failed)', () => {
    expect(isTemplateAvailable(claude, {})).toBe(true)
  })
})

describe('perf mock agent (perf harness only)', () => {
  it('is never offered in the catalog', () => {
    expect(TEMPLATES.some((t) => t.id === PERF_MOCK_AGENT_ID)).toBe(false)
  })
  it('runs only the local generator in dev builds', () => {
    expect(agentCommand(PERF_MOCK_AGENT_ID)).toBe(PERF_MOCK_AGENT_COMMAND)
    expect(PERF_MOCK_AGENT_COMMAND).toBe('node agent-stream.mjs --mock')
    expect(templateById(PERF_MOCK_AGENT_ID).executable).toBeUndefined()
    expect(isPlainShellPane(PERF_MOCK_AGENT_ID)).toBe(false)
    expect(manifestForAgent(PERF_MOCK_AGENT_ID)?.id).toBe(PERF_MOCK_AGENT_ID)
  })
})

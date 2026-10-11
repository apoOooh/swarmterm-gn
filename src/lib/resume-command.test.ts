import { describe, expect, it } from 'vitest'
import { buildContinueCommand, buildResumeCommand, isValidSessionId } from '@/lib/resume-command'
import { withLaunchMode } from '@/lib/templates'

const CLAUDE_ID = 'fe845bc6-6932-4459-8fb6-cdd0e7c6cc84'
const CODEX_ID = '018f3b2a-7c1d-4e0a-9b2f-1a2b3c4d5e6f'
const OPENCODE_ID = 'ses_8fk2ab34cd56EfGh78Ij90Kl12'

describe('isValidSessionId', () => {
  it('accepts a UUID for claude-code and codex', () => {
    expect(isValidSessionId('claude-code', CLAUDE_ID)).toBe(true)
    expect(isValidSessionId('codex', CODEX_ID)).toBe(true)
  })
  it('accepts ses_<base62> for opencode', () => {
    expect(isValidSessionId('opencode', OPENCODE_ID)).toBe(true)
  })
  it('rejects shell metacharacters, wrong shapes, and cross-agent ids', () => {
    expect(isValidSessionId('claude-code', 'fe845bc6; rm -rf /')).toBe(false)
    expect(isValidSessionId('claude-code', 'not-a-uuid')).toBe(false)
    expect(isValidSessionId('opencode', CLAUDE_ID)).toBe(false)
    expect(isValidSessionId('codex', '$(whoami)')).toBe(false)
    expect(isValidSessionId('claude-code', '')).toBe(false)
  })
})

describe('buildResumeCommand', () => {
  it('claude-code: base command + --resume', () => {
    expect(buildResumeCommand('claude-code', CLAUDE_ID)).toBe(
      `claude --resume ${CLAUDE_ID} --permission-mode default`
    )
  })
  it('codex: resume subcommand (not a flag)', () => {
    expect(buildResumeCommand('codex', CODEX_ID)).toBe(`codex resume ${CODEX_ID} -s workspace-write -a on-request`)
  })
  it('opencode: --session flag', () => {
    expect(buildResumeCommand('opencode', OPENCODE_ID)).toBe(
      `opencode --session ${OPENCODE_ID}`
    )
  })
  it('wave-1 resume commands follow the herdr table', () => {
    const id = 'fe845bc6-6932-4459-8fb6-cdd0e7c6cc84'
    expect(buildResumeCommand('copilot', id)).toBe(`copilot --resume=${id}`)
    expect(buildResumeCommand('qwen', id)).toBe(`qwen --resume ${id}`)
    expect(buildResumeCommand('amp', id)).toBeUndefined()
  })
  it('wave-2 resume commands follow the herdr table', () => {
    const id = 'fe845bc6-6932-4459-8fb6-cdd0e7c6cc84'
    expect(buildResumeCommand('cursor', id)).toBe(`cursor-agent --resume ${id}`)
    expect(buildResumeCommand('antigravity', id)).toBe(`agy --conversation ${id}`)
    expect(buildResumeCommand('omp', 'ses.abc-123')).toBe('omp --resume=ses.abc-123')
    expect(buildResumeCommand('omp', 'a b; rm -rf /')).toBeUndefined()
    expect(buildResumeCommand('gemini', id)).toBeUndefined()
  })
  it('returns undefined for invalid ids, plain terminal, unknown agents', () => {
    expect(buildResumeCommand('claude-code', 'bogus; id')).toBeUndefined()
    expect(buildResumeCommand('terminal', CLAUDE_ID)).toBeUndefined()
    expect(buildResumeCommand('unknown-agent', CLAUDE_ID)).toBeUndefined()
  })
})

describe('claude launch modes', () => {
  it('defaults to the normal (asking) permission mode', () => {
    expect(withLaunchMode('claude', 'claude-code', undefined)).toBe('claude --permission-mode default')
  })
  it('maps each mode onto its CLI flag', () => {
    expect(withLaunchMode('claude', 'claude-code', 'acceptEdits')).toBe('claude --permission-mode acceptEdits')
    expect(withLaunchMode('claude', 'claude-code', 'plan')).toBe('claude --permission-mode plan')
    expect(withLaunchMode('claude', 'claude-code', 'auto')).toBe('claude --permission-mode auto')
    expect(withLaunchMode('claude', 'claude-code', 'bypass')).toBe('claude --dangerously-skip-permissions')
  })
  it('resume and continue carry the mode', () => {
    expect(buildResumeCommand('claude-code', CLAUDE_ID, 'bypass')).toBe(
      `claude --resume ${CLAUDE_ID} --dangerously-skip-permissions`
    )
    expect(buildContinueCommand('claude-code', 'plan')).toBe('claude --continue --permission-mode plan')
    expect(buildContinueCommand('claude-code', 'bypass', 'pick')).toBe('claude --resume --dangerously-skip-permissions')
  })
})

describe('codex launch modes', () => {
  it('appends the default (auto) mode args when no mode is set', () => {
    expect(withLaunchMode('codex', 'codex', undefined)).toBe('codex -s workspace-write -a on-request')
  })
  it('appends the chosen mode args, unknown ids fall back to the default', () => {
    expect(withLaunchMode('codex', 'codex', 'yolo')).toBe('codex --dangerously-bypass-approvals-and-sandbox')
    expect(withLaunchMode('codex', 'codex', 'nope')).toBe('codex -s workspace-write -a on-request')
  })
  it('leaves agents without modes untouched', () => {
    expect(withLaunchMode('opencode', 'opencode', 'yolo')).toBe('opencode')
  })
  it('resume keeps the session and carries the mode args after the id', () => {
    expect(buildResumeCommand('codex', CODEX_ID, 'safe')).toBe(
      `codex resume ${CODEX_ID} -s read-only -a on-request`
    )
  })
  it('continue resumes the latest session under the new mode', () => {
    expect(buildContinueCommand('codex', 'yolo')).toBe(
      'codex resume --last --dangerously-bypass-approvals-and-sandbox'
    )
    expect(buildContinueCommand('opencode', 'yolo')).toBeUndefined()
  })
  it('pick opens the codex session picker under the mode', () => {
    expect(buildContinueCommand('codex', 'safe', 'pick')).toBe('codex resume -s read-only -a on-request')
  })
})

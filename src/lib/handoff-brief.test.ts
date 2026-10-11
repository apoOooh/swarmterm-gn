import { describe, expect, it } from 'vitest'
import { buildHandoffBrief, EMPTY_DRAFT, MAX_EXCERPT_LINES, trimExcerpt, type HandoffContext } from './handoff-brief'

const ctx: HandoffContext = {
  agentName: 'Claude Code',
  accountLabel: 'work',
  cwd: 'C:/src/app',
  sessionId: 'abc-123',
  git: {
    branch: 'feat/x',
    headSha: 'deadbeef',
    ahead: 2,
    behind: 0,
    changedFiles: [{ path: 'src/a.ts', status: 'M', added: 3, removed: 1 }]
  }
}

describe('buildHandoffBrief', () => {
  it('includes context, git and diff reference', () => {
    const out = buildHandoffBrief(ctx, EMPTY_DRAFT)
    expect(out).toContain('- Account: work')
    expect(out).toContain('- Working directory: C:/src/app')
    expect(out).toContain('- Session: abc-123')
    expect(out).toContain('- Branch: feat/x')
    expect(out).toContain('- HEAD: deadbeef')
    expect(out).toContain('2 ahead, 0 behind upstream')
    expect(out).toContain('`git diff deadbeef` (1 changed files)')
    expect(out).toContain('  - M src/a.ts (+3 -1)')
  })

  it('marks every user field as user-stated and empty fields as not stated', () => {
    const out = buildHandoffBrief(ctx, { ...EMPTY_DRAFT, task: 'Fix login', tests: 'npm test green' })
    expect(out.match(/Stated by the user, not verified from terminal output/g)).toHaveLength(4)
    expect(out).toContain('## Task\n_Stated by the user, not verified from terminal output._\nFix login')
    expect(out).toContain('## Status\n_Stated by the user, not verified from terminal output._\n(not stated)')
  })

  it('omits the excerpt unless one is passed, and marks it incomplete', () => {
    expect(buildHandoffBrief(ctx, EMPTY_DRAFT)).not.toContain('Terminal excerpt')
    expect(buildHandoffBrief(ctx, EMPTY_DRAFT, { terminalExcerpt: '  \n' })).not.toContain('Terminal excerpt')
    const out = buildHandoffBrief(ctx, EMPTY_DRAFT, { terminalExcerpt: '$ npm test\nok' })
    expect(out).toContain('## Terminal excerpt (incomplete)')
    expect(out).toContain('proves neither the task nor test results')
    expect(out).toContain('```text\n$ npm test\nok\n```')
  })

  it('handles missing git, clean trees, no upstream and defaults', () => {
    const bare = buildHandoffBrief({ agentName: 'Terminal', cwd: 'C:/x' }, EMPTY_DRAFT)
    expect(bare).toContain('Not a git repository')
    expect(bare).toContain('- Account: default')
    expect(bare).toContain('- Session: unknown')
    const clean = buildHandoffBrief(
      { ...ctx, git: { ...ctx.git!, ahead: null, behind: null, changedFiles: [] } },
      EMPTY_DRAFT
    )
    expect(clean).toContain('no upstream')
    expect(clean).toContain('clean (no diff against HEAD)')
  })

  it('cannot close the excerpt fence from inside', () => {
    const out = buildHandoffBrief(ctx, EMPTY_DRAFT, { terminalExcerpt: 'a\n```\nb' })
    expect(out.match(/```/g)).toHaveLength(2)
  })
})

describe('trimExcerpt', () => {
  it('keeps the tail and reports truncation', () => {
    const raw = Array.from({ length: MAX_EXCERPT_LINES + 5 }, (_, i) => `l${i}`).join('\n')
    const { text, truncated } = trimExcerpt(raw)
    expect(truncated).toBe(true)
    expect(text.split('\n')).toHaveLength(MAX_EXCERPT_LINES)
    expect(text.endsWith(`l${MAX_EXCERPT_LINES + 4}`)).toBe(true)
  })

  it('strips escape sequences and control bytes', () => {
    expect(trimExcerpt('\x1b[31mred\x1b[0m\x07 ok\n\n').text).toBe('red ok')
  })
})

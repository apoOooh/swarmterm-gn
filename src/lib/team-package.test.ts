import { describe, expect, it } from 'vitest'
import { canConfirm, describeTeamPackageError, mentionsCodex, type TeamPackagePreview } from './team-package'

const preview = (over: Partial<TeamPackagePreview> = {}): TeamPackagePreview => ({
  op: 'install',
  dryRun: true,
  commit: 'abc123',
  fingerprint: 'f'.repeat(64),
  exitCode: 0,
  timedOut: false,
  output: 'plan',
  ...over
})

describe('team package', () => {
  it('confirms only a clean dry run of a writing operation', () => {
    expect(canConfirm(preview())).toBe(true)
    expect(canConfirm(preview({ exitCode: 1 }))).toBe(false)
    expect(canConfirm(preview({ timedOut: true, exitCode: null }))).toBe(false)
    expect(canConfirm(preview({ op: 'check', dryRun: false }))).toBe(false)
    expect(canConfirm(preview({ dryRun: false }))).toBe(false)
    expect(canConfirm(null)).toBe(false)
  })

  it('turns backend codes into calm messages, never a raw failure state', () => {
    expect(describeTeamPackageError('unreachable: fatal: repository not found')).toEqual({
      kind: 'unreachable',
      text: 'The source cannot be reached right now. Nothing was changed. (fatal: repository not found)'
    })
    expect(describeTeamPackageError('changed-since-preview').kind).toBe('changed')
    expect(describeTeamPackageError('busy').kind).toBe('busy')
    expect(describeTeamPackageError('Node.js was not found. Install Node.js and try again.')).toEqual({
      kind: 'error',
      text: 'Node.js was not found. Install Node.js and try again.'
    })
    expect(describeTeamPackageError(new Error('x')).text).toBe('x')
  })

  it('spots a Codex mention for the /hooks hint', () => {
    expect(mentionsCodex('harness codex: hooks added')).toBe(true)
    expect(mentionsCodex('Codex')).toBe(true)
    expect(mentionsCodex('claude only')).toBe(false)
  })
})

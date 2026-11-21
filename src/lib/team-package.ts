/**
 * Team package (SWA-98): the rules Settings needs around the backend's
 * `team_package_*` commands. Rust enforces the real gates (source rules,
 * admin lock, fingerprint match); this only decides what the dialog offers
 * and how a failure reads.
 */

export type TeamPackageOp = 'install' | 'update' | 'uninstall' | 'check'

/** Mirrors `team_package::RunOutcome` (camelCase serde). */
export interface TeamPackagePreview {
  op: TeamPackageOp
  dryRun: boolean
  commit: string | null
  fingerprint: string
  exitCode: number | null
  timedOut: boolean
  output: string
}

/** A run may be confirmed only after a clean `--dry-run` of a writing op. */
export function canConfirm(p: TeamPackagePreview | null): boolean {
  return !!p && p.op !== 'check' && p.dryRun && !p.timedOut && p.exitCode === 0
}

export type TeamPackageErrorKind = 'unreachable' | 'changed' | 'busy' | 'error'

/** Unreachable sources are an expected state ("no access"), not an error. */
export function describeTeamPackageError(err: unknown): { kind: TeamPackageErrorKind; text: string } {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.startsWith('unreachable:')) {
    const detail = raw.slice('unreachable:'.length).trim()
    return {
      kind: 'unreachable',
      text: `The source cannot be reached right now. Nothing was changed.${detail ? ` (${detail})` : ''}`
    }
  }
  if (raw === 'changed-since-preview') {
    return { kind: 'changed', text: 'The package changed since the preview. Run the preview again.' }
  }
  if (raw === 'busy') return { kind: 'busy', text: 'Another team package action is still running.' }
  return { kind: 'error', text: raw }
}

/** Codex asks the user to approve new hooks itself (`/hooks`); Swarmterm never does it for them. */
export function mentionsCodex(output: string): boolean {
  return /\bcodex\b/i.test(output)
}

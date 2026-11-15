import { invoke } from '@tauri-apps/api/core'
import type { TeamPackageOp, TeamPackagePreview } from '@/lib/team-package'

export interface TeamPackageState {
  source: string | null
  /** Refusal text when the edition or an administrator locks the feature. */
  locked: string | null
}

export const getTeamPackage = (): Promise<TeamPackageState> => invoke('team_package_get')

/** `null` clears the source. Changing it discards Swarmterm's own checkout. */
export const setTeamPackageSource = (source: string | null): Promise<TeamPackageState> =>
  invoke('team_package_set_source', { source })

/** Fetches the source, then runs `<op> --dry-run` (`check` runs as is). */
export const previewTeamPackage = (op: TeamPackageOp): Promise<TeamPackagePreview> =>
  invoke('team_package_preview', { op })

/** The confirmed run; refused when the package changed since the preview. */
export const runTeamPackage = (op: TeamPackageOp, fingerprint: string): Promise<TeamPackagePreview> =>
  invoke('team_package_run', { op, fingerprint })

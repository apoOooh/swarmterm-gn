import { invoke } from '@tauri-apps/api/core'
import type { CommandResult } from '@/lib/routine-scheduler'

/** Command routines (SWA-67): runs one shell line without a pane; resolves when it finished or timed out. */
export function runRoutineCommand(command: string, cwd: string, timeoutSecs: number): Promise<CommandResult> {
  return invoke('run_routine_command', { command, cwd, timeoutSecs })
}

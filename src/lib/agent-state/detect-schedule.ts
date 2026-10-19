import type { AgentEngineState } from '@/lib/agent-state/types'

/** Tick cadence while an agent pane is live; 100ms (PENDING_IDLE_RECHECK_MS)
 *  applies instead while a pending-idle hold is open. */
export const TICK_MS = 300

/** Agent TUIs draw menus/banners while booting that look like blockers;
 *  herdr skips screen detection entirely for 3s after spawn. */
export const SPAWN_GRACE_MS = 3000

export function inSpawnGrace(spawnedAt: number, now: number): boolean {
  return now - spawnedAt < SPAWN_GRACE_MS
}

/** Steady-state idle or working with no new pty output since the last scan:
 *  don't even materialize the buffer text. This is what makes 300ms polling
 *  free. The verdict is a pure function of the screen and the OSC title /
 *  progress (both of which bump `contentSeq`, see detector.ts), so an
 *  unchanged seq cannot change it — a `working` pane whose agent is thinking
 *  silently would otherwise rebuild the same snapshot ~3x a second.
 *
 *  A live hook mark disables the skip: hooks are clock-driven, not
 *  output-driven, so both the arrival tick AND the TTL expiry must be
 *  observed on a pane that emits nothing (Claude prints no new bytes when a
 *  `working` mark silently expires after an Esc interrupt). */
export function shouldSkipScreenScan(args: {
  state: AgentEngineState
  contentSeq: number
  lastScannedSeq: number
  pendingIdle: boolean
  hookActive: boolean
}): boolean {
  return (
    (args.state === 'idle' || args.state === 'working') &&
    !args.pendingIdle &&
    args.contentSeq === args.lastScannedSeq &&
    !args.hookActive
  )
}

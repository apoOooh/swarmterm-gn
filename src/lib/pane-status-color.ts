import type { DisplayState } from '@/lib/agent-state/types'

/** Same hues as the state dots (StateDot.tsx), so frame and dot read as one signal. */
export const WORKING_START = '#facb17'
/** Where a long-running turn ends up: orange says "this one is taking a while". */
export const WORKING_END = '#f5761a'
export const BLOCKED_COLOR = '#F14C4C'
export const DONE_COLOR = '#23D18B'

export type PaneStatusToneName = 'working' | 'blocked' | 'done'

export interface PaneStatusTone {
  tone: PaneStatusToneName
  /** `#rrggbb`, so callers can append an alpha byte for the glow. */
  color: string
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function toHex(c: number): string {
  return Math.round(c).toString(16).padStart(2, '0')
}

/** Linear RGB mix; `t` is clamped to [0, 1]. */
export function mixHex(from: string, to: string, t: number): string {
  const k = Math.min(1, Math.max(0, t))
  const a = channels(from)
  const b = channels(to)
  return `#${toHex(a[0] + (b[0] - a[0]) * k)}${toHex(a[1] + (b[1] - a[1]) * k)}${toHex(a[2] + (b[2] - a[2]) * k)}`
}

/**
 * The frame a pane wears for its agent state. Idle/unknown (and plain shells,
 * which never get a state) wear none — the highlight only marks panes that
 * want attention or are busy. `done` is already "idle and not yet seen", so
 * focusing the pane clears the green with no extra bookkeeping here.
 */
export function paneStatusTone(
  display: DisplayState | undefined,
  ageMs: number,
  gradientMinutes: number
): PaneStatusTone | null {
  switch (display) {
    case 'blocked':
      return { tone: 'blocked', color: BLOCKED_COLOR.toLowerCase() }
    case 'done':
      return { tone: 'done', color: DONE_COLOR.toLowerCase() }
    case 'working': {
      const t = gradientMinutes > 0 ? ageMs / (gradientMinutes * 60_000) : 0
      return { tone: 'working', color: mixHex(WORKING_START, WORKING_END, t) }
    }
    default:
      return null
  }
}

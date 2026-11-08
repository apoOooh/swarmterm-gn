import { describe, expect, it } from 'vitest'
import {
  IDLE_DWELL_MS,
  MAX_IDLE_HOLD_MS,
  NOISE_BYTES_PER_SEC,
  busyPaneReady,
  deliveryHoldReason,
  holdReasonCopy,
  type BusyPaneSnapshot
} from './war-room-nudge'

const T0 = 1_000_000
const snap = (over: Partial<BusyPaneSnapshot> = {}): BusyPaneSnapshot => ({
  agentState: 'idle',
  agentSinceMs: T0,
  outputBytesPerSec: 0,
  waitingSinceMs: T0,
  forced: false,
  ...over
})

/** EWMA (tau 1 s) of a 1.5 KB status line repainted every 5 s, sampled
 *  `msAfter` the latest repaint — mirrors renderer-policy's impulse model. */
const statusLineRate = (msAfter: number): number => 1500 * Math.exp(-msAfter / 1000)

describe('busyPaneReady', () => {
  it('idle with only status-line repaint noise delivers after the dwell', () => {
    expect(busyPaneReady(snap({ outputBytesPerSec: statusLineRate(1500) }), T0 + IDLE_DWELL_MS)).toBe(true)
  })

  it('right after a status-line repaint it waits, then releases within ~1.5 s', () => {
    expect(busyPaneReady(snap({ outputBytesPerSec: statusLineRate(100) }), T0 + 10_000)).toBe(false)
    expect(statusLineRate(1500)).toBeLessThan(NOISE_BYTES_PER_SEC)
  })

  it('a fresh idle verdict waits out the dwell even with no output', () => {
    expect(busyPaneReady(snap(), T0 + IDLE_DWELL_MS - 1)).toBe(false)
  })

  it('a 100 ms spinner (sustained output) holds while idle-by-detector until the valve', () => {
    const spinner = snap({ outputBytesPerSec: 2000 })
    expect(busyPaneReady(spinner, T0 + MAX_IDLE_HOLD_MS - 1)).toBe(false)
    expect(busyPaneReady(spinner, T0 + MAX_IDLE_HOLD_MS)).toBe(true)
  })

  it('valve counts from the later of idle start and queue start', () => {
    const s = snap({ outputBytesPerSec: 2000, agentSinceMs: T0, waitingSinceMs: T0 + 15_000 })
    expect(busyPaneReady(s, T0 + MAX_IDLE_HOLD_MS + 1000)).toBe(false)
    expect(busyPaneReady(s, T0 + 15_000 + MAX_IDLE_HOLD_MS)).toBe(true)
  })

  it('working / blocked / unknown never pass the relaxed gate (nor the valve)', () => {
    for (const agentState of ['working', 'blocked', 'unknown', undefined] as const) {
      expect(busyPaneReady(snap({ agentState }), T0 + MAX_IDLE_HOLD_MS * 10)).toBe(false)
    }
  })

  it('forced waives the output gate', () => {
    expect(busyPaneReady(snap({ agentState: undefined, outputBytesPerSec: 9e9, forced: true }), T0)).toBe(true)
  })
})

describe('deliveryHoldReason draft + copy', () => {
  const base = { focused: false, lastKeyAt: undefined, dirty: false }
  it('a screen draft holds even without a dirty flag, after the agent reasons', () => {
    expect(deliveryHoldReason({ ...base, agentState: 'idle', draft: true }, T0)).toBe('draft')
    expect(deliveryHoldReason({ ...base, agentState: 'blocked', draft: true }, T0)).toBe('agent-blocked')
    expect(deliveryHoldReason({ ...base, agentState: 'idle', draft: false }, T0)).toBeNull()
  })

  it('draft is not releasable, pane-busy is', () => {
    expect(holdReasonCopy('draft').releasable).toBe(false)
    expect(holdReasonCopy('draft').title).toMatch(/unsent text/)
    expect(holdReasonCopy('pane-busy').releasable).toBe(true)
  })
})

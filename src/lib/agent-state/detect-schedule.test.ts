import { describe, expect, it } from 'vitest'
import { inSpawnGrace, shouldSkipScreenScan, SPAWN_GRACE_MS } from '@/lib/agent-state/detect-schedule'

describe('inSpawnGrace', () => {
  it('is true strictly inside the window, false at and after its end', () => {
    expect(inSpawnGrace(1000, 1000 + SPAWN_GRACE_MS - 1)).toBe(true)
    expect(inSpawnGrace(1000, 1000 + SPAWN_GRACE_MS)).toBe(false)
  })
})

describe('shouldSkipScreenScan', () => {
  it('skips only when idle or working with no new output and no pending hold', () => {
    expect(shouldSkipScreenScan({ state: 'idle', contentSeq: 5, lastScannedSeq: 5, pendingIdle: false, hookActive: false })).toBe(true)
    expect(shouldSkipScreenScan({ state: 'idle', contentSeq: 6, lastScannedSeq: 5, pendingIdle: false, hookActive: false })).toBe(false)
    expect(shouldSkipScreenScan({ state: 'working', contentSeq: 5, lastScannedSeq: 5, pendingIdle: false, hookActive: false })).toBe(true)
    expect(shouldSkipScreenScan({ state: 'working', contentSeq: 6, lastScannedSeq: 5, pendingIdle: false, hookActive: false })).toBe(false)
    expect(shouldSkipScreenScan({ state: 'working', contentSeq: 5, lastScannedSeq: 5, pendingIdle: true, hookActive: false })).toBe(false)
    // Blocked/unknown keep scanning every tick, as before.
    expect(shouldSkipScreenScan({ state: 'blocked', contentSeq: 5, lastScannedSeq: 5, pendingIdle: false, hookActive: false })).toBe(false)
    expect(shouldSkipScreenScan({ state: 'unknown', contentSeq: 5, lastScannedSeq: 5, pendingIdle: false, hookActive: false })).toBe(false)
    expect(shouldSkipScreenScan({ state: 'idle', contentSeq: 5, lastScannedSeq: 5, pendingIdle: true, hookActive: false })).toBe(false)
  })

  it('never skips while a hook is active', () => {
    // A live hook must be observed on its arrival tick AND on the tick its TTL
    // expires — even on a pane that emits nothing, which is exactly the case
    // the idle+unchanged-seq skip was built for.
    expect(shouldSkipScreenScan({ state: 'idle', contentSeq: 5, lastScannedSeq: 5, pendingIdle: false, hookActive: true })).toBe(false)
    expect(shouldSkipScreenScan({ state: 'working', contentSeq: 5, lastScannedSeq: 5, pendingIdle: false, hookActive: true })).toBe(false)
  })
})

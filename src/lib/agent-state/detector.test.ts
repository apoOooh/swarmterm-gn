import { describe, expect, it } from 'vitest'
import { AgentStateDetector, type DetectorDeps } from '@/lib/agent-state/detector'
import { SPAWN_GRACE_MS, TICK_MS } from '@/lib/agent-state/detect-schedule'
import { TTL_WORKING_MS } from '@/lib/agent-state/hook-signal'
import type { AgentEngineState, Manifest } from '@/lib/agent-state/types'

const manifest: Manifest = {
  id: 'test',
  herdrVersion: 't',
  rules: [
    { id: 'working', state: 'working', priority: 500, region: 'whole_recent', contains: ['esc to interrupt'] },
    { id: 'blocked', state: 'blocked', priority: 900, region: 'whole_recent', contains: ['do you want to proceed?'], visibleBlocker: true },
    // No other screen in this file contains `❯`, so the pre-hook specs are
    // unaffected by this rule.
    { id: 'prompt', state: 'idle', priority: 400, region: 'whole_recent', contains: ['❯'], visibleIdle: true }
  ]
}

interface Harness {
  detector: AgentStateDetector
  published: AgentEngineState[]
  /** How many times the detector materialized the screen (a real scan). */
  scans(): number
  setScreen(text: string): void
  /** Advance the manual clock and fire the single pending timer. */
  tick(ms?: number): void
}

function makeHarness(): Harness {
  let screen = ''
  let now = 0
  let pending: { fn: () => void } | null = null
  let scans = 0
  const published: AgentEngineState[] = []
  const deps: DetectorDeps = {
    getView: () => {
      scans++
      return { rows: 24, length: 1, line: () => screen }
    },
    isPaneWatched: () => false,
    publish: (state) => published.push(state),
    now: () => now,
    setTimer: (fn) => {
      pending = { fn }
      return pending
    },
    clearTimer: () => {
      pending = null
    }
  }
  const detector = new AgentStateDetector(manifest, deps)
  return {
    detector,
    published,
    scans: () => scans,
    setScreen: (text) => {
      screen = text
      detector.noteOutput()
    },
    tick: (ms = TICK_MS) => {
      now += ms
      const p = pending
      pending = null
      p?.fn()
    }
  }
}

describe('AgentStateDetector', () => {
  it('publishes nothing during the spawn grace window', () => {
    const h = makeHarness()
    h.detector.start()
    h.setScreen('Do you want to proceed?')
    h.tick()
    expect(h.published).toEqual([])
  })

  it('detects blocked immediately after grace', () => {
    const h = makeHarness()
    h.detector.start()
    h.setScreen('Do you want to proceed?')
    h.tick(SPAWN_GRACE_MS)
    h.tick()
    expect(h.published).toEqual(['blocked'])
  })

  it('holds working → idle across confirmations, then publishes idle', () => {
    const h = makeHarness()
    h.detector.start()
    // The grace-crossing tick scans an EMPTY screen and settles to idle
    // (the no-match fallback) — that leading publish is expected.
    h.tick(SPAWN_GRACE_MS)
    h.setScreen('thinking… esc to interrupt')
    h.tick()
    expect(h.published).toEqual(['idle', 'working'])
    h.setScreen('$ quiet prompt')
    h.tick() // idle verdict #1 — held
    h.tick(100) // #2
    h.tick(100) // #3
    h.tick(100) // #4 — released
    expect(h.published).toEqual(['idle', 'working', 'idle'])
  })

  it('reset returns to unknown and re-arms the grace window', () => {
    const h = makeHarness()
    h.detector.start()
    h.tick(SPAWN_GRACE_MS) // empty screen settles to idle
    h.setScreen('Do you want to proceed?')
    h.tick()
    expect(h.published).toEqual(['idle', 'blocked'])
    h.detector.reset()
    expect(h.published).toEqual(['idle', 'blocked', 'unknown'])
    h.tick() // still inside the fresh grace window — no detection
    expect(h.published).toEqual(['idle', 'blocked', 'unknown'])
  })

  it('noteExit stops the loop and publishes unknown', () => {
    const h = makeHarness()
    h.detector.start()
    h.tick(SPAWN_GRACE_MS) // empty screen settles to idle
    h.setScreen('thinking… esc to interrupt')
    h.tick()
    h.detector.noteExit()
    expect(h.published).toEqual(['idle', 'working', 'unknown'])
  })

  it('resumes detection after a pty exit + respawn (reset), instead of dying forever', () => {
    const h = makeHarness()
    h.detector.start()
    h.tick(SPAWN_GRACE_MS) // empty screen settles to idle
    h.setScreen('thinking… esc to interrupt')
    h.tick()
    expect(h.published).toEqual(['idle', 'working'])
    h.detector.noteExit()
    expect(h.published).toEqual(['idle', 'working', 'unknown'])
    // The tick scheduled before the exit fires once more, hits the `exited`
    // early-return, and (correctly) does not reschedule itself — this is the
    // realistic gap between a pty dying and a later respawn's reset() call.
    h.tick()
    h.detector.reset()
    h.setScreen('Do you want to proceed?')
    h.tick(SPAWN_GRACE_MS) // fresh grace window armed by reset()
    // Detection must have resumed: the new screen's verdict gets published,
    // not silence forever.
    expect(h.published).toEqual(['idle', 'working', 'unknown', 'blocked'])
  })
})

describe('AgentStateDetector — hook signals', () => {
  // Every spec crosses the grace window first; the grace-crossing tick scans
  // an EMPTY screen and settles to idle, so a leading 'idle' publish is
  // expected (same as the hold spec above).
  function afterGrace(): Harness {
    const h = makeHarness()
    h.detector.start()
    h.tick(SPAWN_GRACE_MS)
    expect(h.published).toEqual(['idle'])
    return h
  }

  it('noteHook(working) on a quiet screen publishes working on the very next tick(0) — no 300 ms wait', () => {
    const h = afterGrace()
    h.detector.noteHook('working')
    // schedule(0): the edge lands now. Had noteHook merely waited for the
    // regular cadence, the idle+unchanged-seq skip would have swallowed it.
    h.tick(0)
    expect(h.published).toEqual(['idle', 'working'])
  })

  it('hook working beats a visibleIdle screen (the false-idle prompt-box frame)', () => {
    const h = afterGrace()
    h.setScreen('❯ ')
    h.detector.noteHook('working')
    h.tick(0)
    expect(h.published).toEqual(['idle', 'working'])
    h.tick() // still live, still working — no re-publish
    expect(h.published).toEqual(['idle', 'working'])
  })

  it('hook working yields to a visible blocker the hook never saw', () => {
    const h = afterGrace()
    h.setScreen('do you want to proceed?')
    h.detector.noteHook('working')
    h.tick(0)
    expect(h.published[h.published.length - 1]).toBe('blocked')
  })

  it('Stop after working publishes idle on the SAME tick — no confirmation hold', () => {
    const h = afterGrace()
    h.setScreen('thinking… esc to interrupt')
    h.tick()
    expect(h.published).toEqual(['idle', 'working'])
    h.setScreen('$ quiet prompt')
    h.detector.noteHook('idle')
    h.tick(0)
    expect(h.published).toEqual(['idle', 'working', 'idle'])
  })

  it('an expired working hook falls back to the scrape (and its hold)', () => {
    const h = afterGrace()
    h.detector.noteHook('working')
    h.tick(0)
    expect(h.published).toEqual(['idle', 'working'])
    h.tick(TTL_WORKING_MS - 1) // strictly inside the TTL — hook still rules
    expect(h.published).toEqual(['idle', 'working'])
    h.tick(1) // TTL reached: state is working so the scan runs → idle verdict, held
    expect(h.published).toEqual(['idle', 'working'])
    h.tick(100)
    h.tick(100)
    h.tick(100)
    expect(h.published).toEqual(['idle', 'working', 'idle'])
  })

  it('noteHook(forget) drops the hook authority', () => {
    const h = afterGrace()
    h.detector.noteHook('working')
    h.tick(0)
    expect(h.published).toEqual(['idle', 'working'])
    h.detector.noteHook('forget')
    h.tick() // scrape rules again: idle verdict, held
    h.tick(100)
    h.tick(100)
    h.tick(100)
    expect(h.published).toEqual(['idle', 'working', 'idle'])
  })

  it('reset() drops the hook — a respawned pty inherits no stale blocked', () => {
    const h = afterGrace()
    h.detector.noteHook('blocked')
    h.tick(0)
    expect(h.published).toEqual(['idle', 'blocked'])
    h.detector.reset()
    h.tick(SPAWN_GRACE_MS)
    expect(h.published[h.published.length - 1]).toBe('idle')
  })

  it('noteExit() drops the hook', () => {
    const h = afterGrace()
    h.detector.noteHook('blocked')
    h.tick(0)
    expect(h.published).toEqual(['idle', 'blocked'])
    h.detector.noteExit()
    expect(h.published).toEqual(['idle', 'blocked', 'unknown'])
    h.detector.reset()
    h.tick(SPAWN_GRACE_MS)
    expect(h.published).toEqual(['idle', 'blocked', 'unknown', 'idle'])
  })

  it('a hook arriving during grace applies at the first post-grace tick', () => {
    const h = makeHarness()
    h.detector.start()
    h.detector.noteHook('blocked')
    h.tick(0)
    expect(h.published).toEqual([]) // grace still holds detection back
    h.tick(SPAWN_GRACE_MS)
    expect(h.published).toEqual(['blocked']) // no leading idle
  })

  it('hook blocked while the screen scrapes working stays working (approved tool still spinning)', () => {
    const h = afterGrace()
    h.setScreen('thinking… esc to interrupt')
    h.tick()
    expect(h.published).toEqual(['idle', 'working'])
    h.detector.noteHook('blocked')
    h.tick(0)
    expect(h.published).toEqual(['idle', 'working'])
  })
})

describe('AgentStateDetector working-state scan skip', () => {
  function working(): Harness {
    const h = makeHarness()
    h.detector.start()
    h.setScreen('thinking… esc to interrupt')
    h.tick(SPAWN_GRACE_MS)
    expect(h.published).toEqual(['working'])
    return h
  }

  it('skips the screen read while working with no new output, rescans on output', () => {
    const h = working()
    const before = h.scans()
    h.tick()
    h.tick()
    expect(h.scans()).toBe(before)
    h.setScreen('$ done')
    h.tick()
    expect(h.scans()).toBe(before + 1)
  })

  it('an OSC title change counts as new content', () => {
    const h = working()
    const before = h.scans()
    h.detector.noteTitle('✳ Claude Code')
    h.tick()
    expect(h.scans()).toBe(before + 1)
  })

  it('noteHook(forget) on a silent working pane still rescans', () => {
    const h = makeHarness()
    h.detector.start()
    h.tick(SPAWN_GRACE_MS)
    h.detector.noteHook('working')
    h.tick(0)
    expect(h.published).toEqual(['idle', 'working'])
    const before = h.scans()
    h.detector.noteHook('forget')
    h.tick(0)
    expect(h.scans()).toBe(before + 1)
  })

  it('an expired hook forces exactly one scan on a silent working pane', () => {
    // The screen scrapes working too, so the fallback scan opens no idle hold
    // (which would keep scanning on its own).
    const h = working()
    h.detector.noteHook('working')
    h.tick(0)
    const before = h.scans()
    h.tick(TTL_WORKING_MS) // TTL expired, no new output: one fallback scan
    expect(h.scans()).toBe(before + 1)
    h.tick() // expiry observed, seq unchanged: skipped again
    h.tick()
    expect(h.scans()).toBe(before + 1)
  })
})

import { describe, expect, it } from 'vitest'
import {
  initialHandoff,
  reduceHandoff,
  handoffTargets,
  sessionHookGaps,
  describeUsage,
  limitHint,
  submitBlocker,
  focusTrapTarget,
  startingHint,
  STARTING_HINT_MS,
  type HandoffState
} from './handoff-flow'

const spawned = (): HandoffState => reduceHandoff(initialHandoff(), { type: 'spawned', terminalId: 't2', agentId: 'claude-code' })
/** Spawned, and the CLI's own session hook arrived for generation 0. */
const start = (): HandoffState => reduceHandoff(spawned(), { type: 'session', terminalId: 't2', agentId: 'claude-code', generation: 0 })

describe('handoff state machine', () => {
  it('waits for the new pane to run before asking for confirmation', () => {
    let s = start()
    expect(s.phase).toBe('starting')
    s = reduceHandoff(s, { type: 'status', kind: 'connecting', generation: 0 })
    expect(s.phase).toBe('starting')
    s = reduceHandoff(s, { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    expect(s).toMatchObject({ phase: 'ready', terminalId: 't2', generation: 0 })
  })

  it('fails when the new pane errors or exits before confirmation', () => {
    expect(reduceHandoff(start(), { type: 'status', kind: 'error', generation: 0 }).phase).toBe('failed')
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    expect(reduceHandoff(ready, { type: 'status', kind: 'exited', generation: 0 }).phase).toBe('failed')
  })

  it('refuses confirmation when the pane generation changed (respawn)', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    const s = reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 1, agent: 'idle' } })
    expect(s.phase).toBe('failed')
    expect(s.error).toMatch(/restarted/)
  })

  it('confirm in ready moves to delivering exactly once', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    const d = reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 0, agent: 'idle' } })
    expect(d.phase).toBe('delivering')
    // A second confirm (double click) is a no-op: no duplicate send.
    expect(reduceHandoff(d, { type: 'confirm', live: { kind: 'running', generation: 0, agent: 'idle' } })).toBe(d)
  })

  it('confirm before ready is ignored', () => {
    const s = start()
    expect(reduceHandoff(s, { type: 'confirm', live: { kind: 'running', generation: 0, agent: 'idle' } })).toBe(s)
  })

  it('held then delivered; delivered is terminal', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    let s = reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 0, agent: 'idle' } })
    s = reduceHandoff(s, { type: 'held', reason: 'typing' })
    expect(s).toMatchObject({ phase: 'delivering', held: 'typing' })
    s = reduceHandoff(s, { type: 'delivered', at: 5 })
    expect(s).toMatchObject({ phase: 'delivered', deliveredAt: 5, held: undefined })
    expect(reduceHandoff(s, { type: 'status', kind: 'exited', generation: 0 })).toBe(s)
    expect(reduceHandoff(s, { type: 'cancel' })).toBe(s)
  })

  it('failed is terminal: no retry path back to delivering', () => {
    const failed = reduceHandoff(start(), { type: 'status', kind: 'error', generation: 0, message: 'boom' })
    expect(failed.error).toBe('boom')
    expect(reduceHandoff(failed, { type: 'status', kind: 'running', generation: 0, agent: 'idle' })).toBe(failed)
    expect(reduceHandoff(failed, { type: 'confirm', live: { kind: 'running', generation: 0, agent: 'idle' } })).toBe(failed)
  })

  it('a pane dying mid-delivery fails the handoff', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    const d = reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 0, agent: 'idle' } })
    expect(reduceHandoff(d, { type: 'status', kind: 'exited', generation: 0 }).phase).toBe('failed')
    expect(reduceHandoff(d, { type: 'status', kind: 'running', generation: 1, agent: 'idle' }).phase).toBe('failed')
  })

  it('cancel before delivery', () => {
    expect(reduceHandoff(initialHandoff(), { type: 'cancel' }).phase).toBe('cancelled')
    expect(reduceHandoff(start(), { type: 'cancel' }).phase).toBe('cancelled')
  })
})

describe('handoffTargets', () => {
  it('lists default plus profiles for Claude Code and Codex', () => {
    const targets = handoffTargets([
      { id: 'a1', agentId: 'codex', name: 'Work', configDir: 'x' },
      { id: 'a2', agentId: 'claude-code', name: 'Max', configDir: 'y' }
    ])
    expect(targets.map((t) => `${t.agentId}:${t.accountId ?? '-'}`)).toEqual([
      'claude-code:-',
      'claude-code:a2',
      'codex:-',
      'codex:a1'
    ])
    expect(targets[1].label).toBe('Claude Code · Max')
  })

  it('hides Codex when it cannot report its session (would wait in starting forever)', () => {
    const gaps = sessionHookGaps([
      { id: 'claude-code', available: true },
      { id: 'codex', available: true, sessionHooks: false }
    ])
    expect([...gaps]).toEqual(['codex'])
    const targets = handoffTargets([{ id: 'a1', agentId: 'codex', name: 'Work', configDir: 'x' }], new Set(['claude-code', 'codex']), gaps)
    expect(targets.map((t) => t.agentId)).toEqual(['claude-code'])
    expect(sessionHookGaps([{ id: 'codex', available: true, sessionHooks: true }]).size).toBe(0)
  })
})

describe('usage', () => {
  it('is unknown with a timestamp without structured data', () => {
    expect(describeUsage(undefined, 1000)).toEqual({ known: false, text: 'Usage unknown', checkedAt: 1000 })
  })
  it('uses structured percentages only', () => {
    expect(describeUsage({ usedPercent: 82.4, source: 'cli', at: 7 }, 1000)).toEqual({ known: true, text: 'Usage 82% (cli)', checkedAt: 7 })
    expect(describeUsage({ usedPercent: Number.NaN, source: 'cli', at: 7 }, 1000).known).toBe(false)
  })
  it('limit text is only a hint', () => {
    expect(limitHint('Claude usage limit reached. Resets 5pm')).toMatch(/hint/i)
    expect(limitHint('all good')).toBeUndefined()
  })
})

describe('agent readiness (review P1)', () => {
  it('detector idle is never readiness: without the session hook the handoff keeps waiting', () => {
    // "command not found" / a CLI back at the shell: the detector falls back
    // to idle for an unrecognised screen.
    let s = spawned()
    for (const agent of [undefined, 'unknown', 'blocked', 'idle'] as const) {
      s = reduceHandoff(s, { type: 'status', kind: 'running', generation: 0, agent })
      expect(s.phase).toBe('starting')
    }
  })

  it('ready only after the target CLI reported its session for the live generation', () => {
    let s = reduceHandoff(spawned(), { type: 'session', terminalId: 't2', agentId: 'claude-code', generation: 0 })
    s = reduceHandoff(s, { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    expect(s).toMatchObject({ phase: 'ready', generation: 0 })
  })

  it('ignores session hooks from another pane, another CLI or an older generation', () => {
    const base = spawned()
    expect(reduceHandoff(base, { type: 'session', terminalId: 't9', agentId: 'claude-code', generation: 0 })).toBe(base)
    expect(reduceHandoff(base, { type: 'session', terminalId: 't2', agentId: 'codex', generation: 0 })).toBe(base)
    const old = reduceHandoff(base, { type: 'session', terminalId: 't2', agentId: 'claude-code', generation: 0 })
    expect(reduceHandoff(old, { type: 'status', kind: 'running', generation: 1, agent: 'idle' }).phase).toBe('starting')
  })

  it('an agent that died back to the shell fails the handoff instead of typing into it', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    expect(reduceHandoff(ready, { type: 'status', kind: 'running', generation: 0, agent: 'unknown' }).phase).toBe('failed')
    expect(reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 0, agent: undefined } }).phase).toBe('failed')
  })

  it('a session hook that beats the detector grace is not a failure (review round 5)', () => {
    // Hook arrives while the detector still reports unknown (3 s grace).
    let s = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0, agent: 'unknown' })
    expect(s.phase).toBe('ready')
    s = reduceHandoff(s, { type: 'status', kind: 'running', generation: 0, agent: 'unknown' })
    expect(s.phase).toBe('ready')
    // Send waits until detection settled.
    expect(reduceHandoff(s, { type: 'confirm', live: { kind: 'running', generation: 0, agent: 'unknown' } })).toBe(s)
    s = reduceHandoff(s, { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    expect(s).toMatchObject({ phase: 'ready', agentSeen: true })
    expect(reduceHandoff(s, { type: 'confirm', live: { kind: 'running', generation: 0, agent: 'idle' } }).phase).toBe('delivering')
  })

  it('during the grace, real negative signals still fail', () => {
    const s = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0, agent: 'unknown' })
    expect(reduceHandoff(s, { type: 'status', kind: 'exited', generation: 0 }).phase).toBe('failed')
    expect(reduceHandoff(s, { type: 'status', kind: 'running', generation: 1, agent: 'unknown' }).phase).toBe('failed')
  })

  it('pasted-but-not-submitted is its own terminal outcome, not success', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0, agent: 'idle' })
    const d = reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 0, agent: 'idle' } })
    const p = reduceHandoff(d, { type: 'pasted', reason: 'you typed in the new pane' })
    expect(p).toMatchObject({ phase: 'pasted', error: 'you typed in the new pane' })
    expect(reduceHandoff(p, { type: 'delivered', at: 1 })).toBe(p)
  })

  it('hides unavailable CLIs as targets', () => {
    const t = handoffTargets([{ id: 'a1', agentId: 'codex', name: 'Work', configDir: 'x' }], new Set(['claude-code']))
    expect(t.map((x) => x.agentId)).toEqual(['claude-code'])
  })
})

describe('submitBlocker (delayed Enter re-check)', () => {
  const ok = { running: true, generation: 3, expectedGeneration: 3, hold: null, agent: 'idle' as const }
  it('allows submit only when nothing changed', () => {
    expect(submitBlocker(ok)).toBeNull()
  })
  it('refuses when the user typed or a prompt appeared after the paste', () => {
    expect(submitBlocker({ ...ok, hold: 'typing' })).toMatch(/typ/i)
    expect(submitBlocker({ ...ok, hold: 'agent-blocked' })).toMatch(/prompt/i)
    expect(submitBlocker({ ...ok, hold: 'agent-working' })).not.toBeNull()
  })
  it('refuses on restart, exit or a lost agent', () => {
    expect(submitBlocker({ ...ok, generation: 4 })).not.toBeNull()
    expect(submitBlocker({ ...ok, running: false })).not.toBeNull()
    expect(submitBlocker({ ...ok, agent: 'unknown' })).not.toBeNull()
  })
})

describe('focusTrapTarget', () => {
  it('wraps Tab and Shift+Tab inside the dialog', () => {
    expect(focusTrapTarget(3, 2, false)).toBe(0)
    expect(focusTrapTarget(3, 0, true)).toBe(2)
    expect(focusTrapTarget(3, 1, false)).toBeNull()
    expect(focusTrapTarget(3, -1, false)).toBe(0)
    expect(focusTrapTarget(0, -1, false)).toBeNull()
  })
})

describe('startingHint (review round 2)', () => {
  it('points at the pane only after the time limit and only while starting', () => {
    expect(startingHint('starting', 1000, 1000 + STARTING_HINT_MS - 1)).toBeUndefined()
    expect(startingHint('starting', 1000, 1000 + STARTING_HINT_MS)).toMatch(/answer its prompt/)
    expect(startingHint('ready', 1000, 1000 + STARTING_HINT_MS * 2)).toBeUndefined()
    expect(startingHint('starting', undefined, 99_999_999)).toBeUndefined()
  })
})

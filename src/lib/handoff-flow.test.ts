import { describe, expect, it } from 'vitest'
import {
  initialHandoff,
  reduceHandoff,
  handoffTargets,
  describeUsage,
  limitHint,
  type HandoffState
} from './handoff-flow'

const start = (): HandoffState => reduceHandoff(initialHandoff(), { type: 'spawned', terminalId: 't2' })

describe('handoff state machine', () => {
  it('waits for the new pane to run before asking for confirmation', () => {
    let s = start()
    expect(s.phase).toBe('starting')
    s = reduceHandoff(s, { type: 'status', kind: 'connecting', generation: 0 })
    expect(s.phase).toBe('starting')
    s = reduceHandoff(s, { type: 'status', kind: 'running', generation: 0 })
    expect(s).toMatchObject({ phase: 'ready', terminalId: 't2', generation: 0 })
  })

  it('fails when the new pane errors or exits before confirmation', () => {
    expect(reduceHandoff(start(), { type: 'status', kind: 'error', generation: 0 }).phase).toBe('failed')
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0 })
    expect(reduceHandoff(ready, { type: 'status', kind: 'exited', generation: 0 }).phase).toBe('failed')
  })

  it('refuses confirmation when the pane generation changed (respawn)', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0 })
    const s = reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 1 } })
    expect(s.phase).toBe('failed')
    expect(s.error).toMatch(/restarted/)
  })

  it('confirm in ready moves to delivering exactly once', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0 })
    const d = reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 0 } })
    expect(d.phase).toBe('delivering')
    // A second confirm (double click) is a no-op: no duplicate send.
    expect(reduceHandoff(d, { type: 'confirm', live: { kind: 'running', generation: 0 } })).toBe(d)
  })

  it('confirm before ready is ignored', () => {
    const s = start()
    expect(reduceHandoff(s, { type: 'confirm', live: { kind: 'running', generation: 0 } })).toBe(s)
  })

  it('held then delivered; delivered is terminal', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0 })
    let s = reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 0 } })
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
    expect(reduceHandoff(failed, { type: 'status', kind: 'running', generation: 0 })).toBe(failed)
    expect(reduceHandoff(failed, { type: 'confirm', live: { kind: 'running', generation: 0 } })).toBe(failed)
  })

  it('a pane dying mid-delivery fails the handoff', () => {
    const ready = reduceHandoff(start(), { type: 'status', kind: 'running', generation: 0 })
    const d = reduceHandoff(ready, { type: 'confirm', live: { kind: 'running', generation: 0 } })
    expect(reduceHandoff(d, { type: 'status', kind: 'exited', generation: 0 }).phase).toBe('failed')
    expect(reduceHandoff(d, { type: 'status', kind: 'running', generation: 1 }).phase).toBe('failed')
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

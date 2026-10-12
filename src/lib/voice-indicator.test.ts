import { describe, expect, it } from 'vitest'
import { applyIndicator, type IndicatorState } from './voice-indicator'

describe('applyIndicator', () => {
  const empty: IndicatorState = {}

  it('turns the pill on and off for the same pin', () => {
    const on = applyIndicator(empty, { terminalId: 't1', pin: 'p1', active: true })
    expect(on).toEqual({ t1: 'p1' })
    expect(applyIndicator(on, { terminalId: 't1', pin: 'p1', active: false })).toEqual({})
  })

  it('ignores an off for a pin the pane no longer shows', () => {
    // A second begin supersedes: Rust may deliver on(new) before off(old).
    const s = applyIndicator(empty, { terminalId: 't1', pin: 'new', active: true })
    const after = applyIndicator(s, { terminalId: 't1', pin: 'old', active: false })
    expect(after).toBe(s)
  })

  it('keeps panes independent', () => {
    let s = applyIndicator(empty, { terminalId: 't1', pin: 'a', active: true })
    s = applyIndicator(s, { terminalId: 't2', pin: 'b', active: true })
    s = applyIndicator(s, { terminalId: 't1', pin: 'a', active: false })
    expect(s).toEqual({ t2: 'b' })
  })

  it('returns the same object when nothing changes', () => {
    const s = applyIndicator(empty, { terminalId: 't1', pin: 'p', active: true })
    expect(applyIndicator(s, { terminalId: 't1', pin: 'p', active: true })).toBe(s)
    expect(applyIndicator(empty, { terminalId: 'x', pin: 'p', active: false })).toBe(empty)
  })
})

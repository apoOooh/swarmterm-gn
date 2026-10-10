import { describe, expect, it } from 'vitest'
import { AGENT_START_FOCUS_GRACE_MS, isFocusReport, shouldDropFocusReport } from './focus-report'

describe('isFocusReport', () => {
  it('matches focus-in and focus-out exactly', () => {
    expect(isFocusReport('\x1b[I')).toBe(true)
    expect(isFocusReport('\x1b[O')).toBe(true)
  })
  it('ignores other input, including reports mixed into typing', () => {
    expect(isFocusReport('a')).toBe(false)
    expect(isFocusReport('\x1b[A')).toBe(false)
    expect(isFocusReport('x\x1b[I')).toBe(false)
  })
})

describe('shouldDropFocusReport', () => {
  it('drops in agent panes inside the start window only', () => {
    expect(shouldDropFocusReport(true, 1000, 1000)).toBe(true)
    expect(shouldDropFocusReport(true, 1000, 1000 + AGENT_START_FOCUS_GRACE_MS - 1)).toBe(true)
    expect(shouldDropFocusReport(true, 1000, 1000 + AGENT_START_FOCUS_GRACE_MS)).toBe(false)
  })
  it('never drops in plain shells', () => {
    expect(shouldDropFocusReport(false, 1000, 1000)).toBe(false)
  })
  it('passes reports before the pty has started', () => {
    expect(shouldDropFocusReport(true, undefined, 5)).toBe(false)
  })
})

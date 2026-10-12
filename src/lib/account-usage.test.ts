import { describe, expect, it } from 'vitest'
import { accountUsageKey, applyUsageSample, describeUsage } from './account-usage'

describe('accountUsageKey', () => {
  it('separates agents and treats undefined as the default profile', () => {
    expect(accountUsageKey('claude-code', undefined)).toBe('claude-code:')
    expect(accountUsageKey('claude-code', 'work')).toBe('claude-code:work')
    expect(accountUsageKey('codex', 'work')).not.toBe(accountUsageKey('claude-code', 'work'))
  })
})

describe('applyUsageSample', () => {
  it('stores valid windows and drops invalid ones', () => {
    expect(applyUsageSample(undefined, { fiveHour: { pct: 42, resetsAt: 9 }, sevenDay: { pct: 120 }, at: 5 })).toEqual({
      fiveHour: { pct: 42, resetsAt: 9 },
      sevenDay: undefined,
      at: 5
    })
  })

  it('ignores a sample without any valid window', () => {
    const prev = { fiveHour: { pct: 1 }, at: 1 }
    expect(applyUsageSample(prev, { fiveHour: null, sevenDay: null, at: 2 })).toBe(prev)
    expect(applyUsageSample(undefined, { fiveHour: { pct: Number.NaN }, at: 2 })).toBeUndefined()
  })

  it('never lets an older sample overwrite a newer one', () => {
    const prev = { fiveHour: { pct: 50 }, at: 10 }
    expect(applyUsageSample(prev, { fiveHour: { pct: 40 }, at: 9 })).toBe(prev)
    expect(applyUsageSample(prev, { fiveHour: { pct: 60 }, at: 11 })?.fiveHour?.pct).toBe(60)
  })
})

describe('describeUsage', () => {
  it('is unknown without a sample, stamped with now', () => {
    expect(describeUsage(undefined, 1000)).toEqual({ known: false, text: 'Usage unknown', checkedAt: 1000 })
    expect(describeUsage({ fiveHour: { pct: Number.NaN }, at: 7 }, 1000).known).toBe(false)
  })

  it('shows both windows, rounded, with the sample time and source', () => {
    const v = describeUsage({ fiveHour: { pct: 82.4 }, sevenDay: { pct: 12 }, at: 7 }, 1000)
    expect(v).toEqual({ known: true, text: 'Usage 5h 82% · 7d 12% (Claude Code status line)', checkedAt: 7 })
  })

  it('mentions the 5h reset when known', () => {
    expect(describeUsage({ fiveHour: { pct: 10, resetsAt: 1_760_000_000 }, at: 7 }, 1000).text).toMatch(/^Usage 5h 10%, resets /)
  })
})

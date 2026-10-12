import { describe, expect, it } from 'vitest'
import { USAGE_STORAGE_KEY, accountUsageKey, applyUsageSample, describeUsage, dropExpiredWindows, readStoredUsage, storeUsage, usageAge } from './account-usage'

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

describe('dropExpiredWindows', () => {
  it('drops windows whose reset already passed and keeps the rest', () => {
    const s = { fiveHour: { pct: 80, resetsAt: 100 }, sevenDay: { pct: 30, resetsAt: 900 }, at: 1 }
    expect(dropExpiredWindows(s, 500_000)).toEqual({ fiveHour: undefined, sevenDay: { pct: 30, resetsAt: 900 }, at: 1 })
  })

  it('keeps windows without a reset and drops a sample with nothing left', () => {
    expect(dropExpiredWindows({ sevenDay: { pct: 5 }, at: 1 }, 9e12)?.sevenDay?.pct).toBe(5)
    expect(dropExpiredWindows({ fiveHour: { pct: 5, resetsAt: 1 }, at: 1 }, 5000)).toBeUndefined()
  })
})

describe('stored usage', () => {
  const memory = (): Storage => {
    const m = new Map<string, string>()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }
  }

  it('round-trips samples and drops expired windows on read', () => {
    const storage = memory()
    storeUsage(storage, {
      'claude-code:': { fiveHour: { pct: 40, resetsAt: 2000 }, sevenDay: { pct: 9, resetsAt: 9000 }, at: 1 },
      'codex:': { fiveHour: { pct: 1, resetsAt: 10 }, at: 1 }
    })
    expect(readStoredUsage(storage, 5_000_000)).toEqual({
      'claude-code:': { fiveHour: undefined, sevenDay: { pct: 9, resetsAt: 9000 }, at: 1 }
    })
  })

  it('survives garbage', () => {
    const storage = memory()
    storage.setItem(USAGE_STORAGE_KEY, '{nope')
    expect(readStoredUsage(storage, 0)).toEqual({})
    storage.setItem(USAGE_STORAGE_KEY, JSON.stringify({ a: { fiveHour: { pct: 'x' }, at: 1 }, b: 3 }))
    expect(readStoredUsage(storage, 0)).toEqual({})
  })
})

describe('usageAge', () => {
  it('is silent while fresh and coarse afterwards', () => {
    const min = 60_000
    expect(usageAge(0, 4 * min)).toBeUndefined()
    expect(usageAge(0, 12 * min)).toBe('12 min ago')
    expect(usageAge(0, 125 * min)).toBe('2 h ago')
    expect(usageAge(0, 50 * 60 * min)).toBe('2 d ago')
  })
})

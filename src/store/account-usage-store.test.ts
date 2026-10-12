import { beforeEach, describe, expect, it } from 'vitest'
import { useAccountUsageStore } from './account-usage-store'

describe('account-usage-store', () => {
  beforeEach(() => useAccountUsageStore.setState({ byAccount: {} }))

  it('keys samples by agent and account profile', () => {
    const { apply } = useAccountUsageStore.getState()
    apply('claude-code', undefined, { fiveHour: { pct: 10 }, at: 1 })
    apply('claude-code', 'work', { fiveHour: { pct: 70 }, at: 2 })
    const { byAccount } = useAccountUsageStore.getState()
    expect(byAccount['claude-code:']?.fiveHour?.pct).toBe(10)
    expect(byAccount['claude-code:work']?.fiveHour?.pct).toBe(70)
  })

  it('keeps the same state object for an ignored sample', () => {
    const { apply } = useAccountUsageStore.getState()
    apply('claude-code', undefined, { fiveHour: { pct: 10 }, at: 5 })
    const before = useAccountUsageStore.getState().byAccount
    apply('claude-code', undefined, { fiveHour: null, sevenDay: null, at: 6 })
    apply('claude-code', undefined, { fiveHour: { pct: 1 }, at: 4 })
    expect(useAccountUsageStore.getState().byAccount).toBe(before)
  })
})

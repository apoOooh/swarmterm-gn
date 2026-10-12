import { create } from 'zustand'
import { accountUsageKey, applyUsageSample, type AccountUsage } from '@/lib/account-usage'

/**
 * Latest rate-limit sample per account profile (`accountUsageKey`). Kept for
 * the app's lifetime on purpose: a closed pane does not change the account's
 * usage, and the shown timestamp says how old the number is.
 */
export interface AccountUsageStore {
  byAccount: Record<string, AccountUsage>
  apply: (agentId: string, accountId: string | undefined, sample: AccountUsage) => void
}

export const useAccountUsageStore = create<AccountUsageStore>((set) => ({
  byAccount: {},
  apply: (agentId, accountId, sample) =>
    set((s) => {
      const key = accountUsageKey(agentId, accountId)
      const next = applyUsageSample(s.byAccount[key], sample)
      return next === s.byAccount[key] || next === undefined ? s : { byAccount: { ...s.byAccount, [key]: next } }
    })
}))

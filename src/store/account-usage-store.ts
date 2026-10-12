import { create } from 'zustand'
import { accountUsageKey, applyUsageSample, readStoredUsage, storeUsage, type AccountUsage } from '@/lib/account-usage'

/**
 * Latest rate-limit sample per account profile (`accountUsageKey`). Kept for
 * the app's lifetime on purpose: a closed pane does not change the account's
 * usage, and the shown timestamp says how old the number is. Mirrored to
 * localStorage so a restart shows the last known numbers instead of `—`.
 */
export interface AccountUsageStore {
  byAccount: Record<string, AccountUsage>
  apply: (agentId: string, accountId: string | undefined, sample: AccountUsage) => void
}

export const useAccountUsageStore = create<AccountUsageStore>((set) => ({
  byAccount: typeof window === 'undefined' ? {} : readStoredUsage(window.localStorage, Date.now()),
  apply: (agentId, accountId, sample) =>
    set((s) => {
      const key = accountUsageKey(agentId, accountId)
      const next = applyUsageSample(s.byAccount[key], sample)
      if (next === s.byAccount[key] || next === undefined) return s
      const byAccount = { ...s.byAccount, [key]: next }
      if (typeof window !== 'undefined') storeUsage(window.localStorage, byAccount)
      return { byAccount }
    })
}))

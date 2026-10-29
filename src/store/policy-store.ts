import { create } from 'zustand'
import { UNMANAGED_POLICY, type AdminPolicy } from '@/lib/policy'
import { getAdminPolicy } from '@/tauri/policy'

export interface PolicyStore {
  /** Admin policy; unmanaged until `load` answers (Rust enforces meanwhile). */
  policy: AdminPolicy
  loaded: boolean
  /** Resolves once the policy is known; repeated calls share one request. */
  load: () => Promise<AdminPolicy>
}

let pending: Promise<AdminPolicy> | null = null

export const usePolicyStore = create<PolicyStore>((set) => ({
  policy: UNMANAGED_POLICY,
  loaded: false,
  load: () => {
    pending ??= getAdminPolicy()
      .catch((err) => {
        console.warn('[policy] policy_get:', err)
        return UNMANAGED_POLICY
      })
      .then((policy) => {
        set({ policy, loaded: true })
        return policy
      })
    return pending
  }
}))

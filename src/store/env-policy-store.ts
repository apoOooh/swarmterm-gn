import { create } from 'zustand'
import { DEFAULT_ENV_POLICY, parseEnvPolicy, readEnvPolicy, storeEnvPolicy, type EnvPolicy } from '@/lib/env-policy'

export interface EnvPolicyStore {
  /** Settings → Terminal "Environment" (secrets filtered by default). */
  policy: EnvPolicy
  setPolicy: (patch: Partial<EnvPolicy>) => void
}

/** Persisted in localStorage; App.tsx pushes it to Rust (`env_policy_set`). */
export const useEnvPolicyStore = create<EnvPolicyStore>((set, get) => ({
  policy: typeof window === 'undefined' ? { ...DEFAULT_ENV_POLICY } : readEnvPolicy(window.localStorage),
  setPolicy: (patch) => {
    const next = parseEnvPolicy({ ...get().policy, ...patch })
    storeEnvPolicy(window.localStorage, next)
    set({ policy: next })
  }
}))

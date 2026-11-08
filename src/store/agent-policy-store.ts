import { create } from 'zustand'
import { DEFAULT_AGENT_POLICY, parseAgentPolicy, readAgentPolicy, storeAgentPolicy, type AgentPolicy } from '@/lib/agent-policy'

export interface AgentPolicyStore {
  /** Settings → Terminal → Agent safety (War Room execute between agents, off by default). */
  policy: AgentPolicy
  setPolicy: (patch: Partial<AgentPolicy>) => void
}

/** Persisted in localStorage; App.tsx pushes it to Rust (`agent_policy_set`). */
export const useAgentPolicyStore = create<AgentPolicyStore>((set, get) => ({
  policy: typeof window === 'undefined' ? { ...DEFAULT_AGENT_POLICY } : readAgentPolicy(window.localStorage),
  setPolicy: (patch) => {
    const next = parseAgentPolicy({ ...get().policy, ...patch })
    storeAgentPolicy(window.localStorage, next)
    set({ policy: next })
  }
}))

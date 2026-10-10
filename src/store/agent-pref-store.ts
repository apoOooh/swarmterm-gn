import { create } from 'zustand'
import { readStoredDefaultAgent, storeDefaultAgent } from '@/lib/agent-pref'
import { DEFAULT_TEMPLATE_ID } from '@/lib/templates'

export interface AgentPrefStore {
  /** Global default agent a split pane starts with (a template id). */
  defaultAgentId: string
  setDefaultAgentId: (id: string) => void
}

/**
 * The global default split agent. Reads the persisted choice on first creation
 * and writes every change back to localStorage. Renderer-only — touches
 * `window` directly.
 */
export const useAgentPrefStore = create<AgentPrefStore>((set) => {
  const initial =
    typeof window === 'undefined' ? DEFAULT_TEMPLATE_ID : readStoredDefaultAgent(window.localStorage)
  return {
    defaultAgentId: initial,
    setDefaultAgentId: (id) => {
      storeDefaultAgent(window.localStorage, id)
      set({ defaultAgentId: id })
    }
  }
})

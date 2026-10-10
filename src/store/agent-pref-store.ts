import { create } from 'zustand'
import {
  readStoredDefaultAgent,
  readStoredLaunchModes,
  storeDefaultAgent,
  storeLaunchModes,
  type LaunchModePrefs
} from '@/lib/agent-pref'
import { DEFAULT_TEMPLATE_ID } from '@/lib/templates'

export interface AgentPrefStore {
  /** Global default agent a split pane starts with (a template id). */
  defaultAgentId: string
  setDefaultAgentId: (id: string) => void
  /** Per-agent launch mode a fresh pane starts in (Settings). */
  defaultLaunchModes: LaunchModePrefs
  setDefaultLaunchMode: (agentId: string, modeId: string) => void
}

/**
 * The global default split agent. Reads the persisted choice on first creation
 * and writes every change back to localStorage. Renderer-only — touches
 * `window` directly.
 */
export const useAgentPrefStore = create<AgentPrefStore>((set, get) => {
  const initial =
    typeof window === 'undefined' ? DEFAULT_TEMPLATE_ID : readStoredDefaultAgent(window.localStorage)
  const initialModes = typeof window === 'undefined' ? {} : readStoredLaunchModes(window.localStorage)
  return {
    defaultAgentId: initial,
    setDefaultAgentId: (id) => {
      storeDefaultAgent(window.localStorage, id)
      set({ defaultAgentId: id })
    },
    defaultLaunchModes: initialModes,
    setDefaultLaunchMode: (agentId, modeId) => {
      const next = { ...get().defaultLaunchModes, [agentId]: modeId }
      storeLaunchModes(window.localStorage, next)
      set({ defaultLaunchModes: next })
    }
  }
})

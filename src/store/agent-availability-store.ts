import { create } from 'zustand'
import { listAvailableAgents } from '@/tauri/agents'
import type { AgentAvailabilityMap } from '@/lib/templates'

/**
 * Which agent CLIs are installed, per the backend probe. Starts as an empty
 * map, which `isTemplateAvailable` reads as "everything available" — so a
 * slow or failed probe never locks out a working CLI. `refresh()` re-probes;
 * call it whenever UI that offers agents opens (app mount, Welcome mount,
 * pane agent dropdown open) so a CLI installed while the app is running is
 * picked up without a restart.
 */
interface AgentAvailabilityState {
  codexSessionHooks: boolean
  availability: AgentAvailabilityMap
  refresh: () => Promise<void>
}

let pendingRefresh: Promise<void> | null = null
export const useAgentAvailabilityStore = create<AgentAvailabilityState>((set, get) => ({
  codexSessionHooks: false,
  availability: {},
  refresh: () => {
    if (pendingRefresh) return pendingRefresh
    pendingRefresh = (async () => {
      try {
        const entries = await listAvailableAgents()
        const next: AgentAvailabilityMap = {}
        for (const e of entries) next[e.id] = e.available
        const codexSessionHooks = entries.find(e => e.id === 'codex')?.sessionHooks === true
        const previous = get()
        const changed = Object.keys(next).length !== Object.keys(previous.availability).length ||
          Object.keys(next).some(id => next[id] !== previous.availability[id])
        if (changed || previous.codexSessionHooks !== codexSessionHooks) {
          set({ availability: changed ? next : previous.availability, codexSessionHooks })
        }
      } catch {
        // Probe failure ⇒ keep the previous (optimistic) map rather than disabling anything.
      }
    })().finally(() => { pendingRefresh = null })
    return pendingRefresh
  }
}))

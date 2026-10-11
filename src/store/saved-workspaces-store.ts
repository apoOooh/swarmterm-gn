import { create } from 'zustand'
import { readSaved, storeSaved, upsertSaved, type SavedWorkspace } from '@/lib/saved-workspaces'
import { startSavedWorkspaceSync } from '@/lib/saved-workspace-sync'
import { prepareSavedWorkspace, savedLeaves } from '@/lib/saved-workspace-restore'
import { inspectSavedWorkspace } from '@/tauri/sessions'
import { useAppStore } from './app-store'
import { useTerminalPrefStore } from './terminal-pref-store'
import { useAgentAvailabilityStore } from './agent-availability-store'
import { useShellAvailabilityStore } from './shell-availability-store'

interface SavedState {
  entries: SavedWorkspace[]
  opening: string[]
  error: string | null
  notice: string | null
  writable: boolean
  hydrate: () => void
  save: (entries: SavedWorkspace[]) => void
  open: (id: string) => Promise<void>
  rename: (id: string, name: string) => void
  forget: (id: string) => void
  dismissNotice: () => void
}

function persist(entries: SavedWorkspace[]): void {
  try { storeSaved(window.localStorage, entries); useSavedWorkspacesStore.setState({ error: null }) }
  catch { useSavedWorkspacesStore.setState({ error: 'Saved workspaces could not be written. Check available storage.' }) }
}
export const useSavedWorkspacesStore = create<SavedState>((set, get) => ({
  entries: [], opening: [], error: null, notice: null, writable: true,
  hydrate: () => {
    try { set({ entries: readSaved(window.localStorage), writable: true, error: null }) }
    catch (e) { set({ writable: false, error: e instanceof Error ? e.message : 'Saved workspaces could not be read.' }) }
  },
  save: (entries) => {
    if (!get().writable) return
    const next = entries.reduce(upsertSaved, get().entries)
    set({ entries: next }); persist(next)
  },
  open: async (id) => {
    const existing = useAppStore.getState().workspaces.find(w => w.savedId === id)
    if (existing) { useAppStore.getState().setActiveWorkspace(existing.id); return }
    const saved = get().entries.find(w => w.id === id)
    if (!saved || get().opening.includes(id)) return
    set({ opening: [...get().opening, id], notice: null })
    try {
      const inspection = await inspectSavedWorkspace(saved.cwd, savedLeaves(saved.layout))
      await Promise.all([useAgentAvailabilityStore.getState().refresh(), useShellAvailabilityStore.getState().refresh()])
      // A user can forget/rename a card while inspection is in flight.
      const latest = get().entries.find(w => w.id === id)
      if (!latest) return
      const result = prepareSavedWorkspace(latest, inspection, useAgentAvailabilityStore.getState().availability, useShellAvailabilityStore.getState().availability)
      useAppStore.getState().restoreWorkspace(result.saved)
      get().save([{ ...result.saved, updatedAt: Date.now() }])
      if (result.warnings.length) set({ notice: result.warnings.join(' ') })
    } catch (e) { set({ notice: e instanceof Error ? e.message : 'Could not open this workspace. Please try again.' }) }
    finally { set({ opening: get().opening.filter(value => value !== id) }) }
  },
  rename: (id, name) => {
    const saved = get().entries.find(w => w.id === id), trimmed = name.trim()
    if (!saved || !trimmed) return
    get().save([{ ...saved, name: trimmed, updatedAt: Date.now() }])
    const open = useAppStore.getState().workspaces.find(w => w.savedId === id)
    if (open) useAppStore.getState().renameWorkspace(open.id, trimmed)
  },
  forget: (id) => {
    useAppStore.getState().forgetWorkspace(id)
    const entries = get().entries.filter(w => w.id !== id)
    set({ entries }); if (get().writable) persist(entries)
  },
  dismissNotice: () => set({ notice: null })
}))

let sync: ReturnType<typeof startSavedWorkspaceSync> | undefined
export function flushSavedWorkspaces(): void { sync?.flush() }
export function wireSavedWorkspaces(): () => void {
  sync?.dispose()
  useSavedWorkspacesStore.getState().hydrate()
  const current = startSavedWorkspaceSync({ app: useAppStore, shell: () => useTerminalPrefStore.getState().shellId, save: entries => useSavedWorkspacesStore.getState().save(entries) })
  sync = current
  const unpref = useTerminalPrefStore.subscribe((next, prev) => { if (next.shellId !== prev.shellId) current.refresh() })
  window.addEventListener('pagehide', current.flush)
  return () => { unpref(); window.removeEventListener('pagehide', current.flush); current.dispose(); if (sync === current) sync = undefined }
}

import { create } from 'zustand'
import {
  BUILTIN_DEFAULT_PRESET,
  addTemplate,
  normalizePreset,
  readStoredDefaultPreset,
  readStoredTemplates,
  removeTemplate,
  storeDefaultPreset,
  storeTemplates,
  updateTemplate,
  type WorkspacePreset,
  type WorkspacePresetTemplate
} from '@/lib/workspace-presets'

export interface WorkspacePresetsStore {
  /** What the new-workspace composer starts with. */
  defaults: WorkspacePreset
  templates: WorkspacePresetTemplate[]
  setDefaults: (preset: WorkspacePreset) => void
  resetDefaults: () => void
  /** Returns the new template's id. */
  addTemplate: (name: string, preset: WorkspacePreset) => string
  updateTemplate: (id: string, name: string, preset: WorkspacePreset) => void
  removeTemplate: (id: string) => void
}

const hasWindow = typeof window !== 'undefined'

/**
 * Workspace defaults and named workspace templates. Reads localStorage on
 * creation and writes every change back. Renderer-only.
 */
export const useWorkspacePresetsStore = create<WorkspacePresetsStore>((set, get) => ({
  defaults: hasWindow ? readStoredDefaultPreset(window.localStorage) : { ...BUILTIN_DEFAULT_PRESET },
  templates: hasWindow ? readStoredTemplates(window.localStorage) : [],
  setDefaults: (preset) => {
    const defaults = normalizePreset(preset)
    storeDefaultPreset(window.localStorage, defaults)
    set({ defaults })
  },
  resetDefaults: () => get().setDefaults(BUILTIN_DEFAULT_PRESET),
  addTemplate: (name, preset) => {
    const id = crypto.randomUUID()
    const templates = addTemplate(get().templates, name, preset, id)
    storeTemplates(window.localStorage, templates)
    set({ templates })
    return id
  },
  updateTemplate: (id, name, preset) => {
    const templates = updateTemplate(get().templates, id, name, preset)
    storeTemplates(window.localStorage, templates)
    set({ templates })
  },
  removeTemplate: (id) => {
    const templates = removeTemplate(get().templates, id)
    storeTemplates(window.localStorage, templates)
    set({ templates })
  }
}))

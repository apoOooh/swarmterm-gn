import { create } from 'zustand'
import {
  parsePromptLibrary,
  removePrompt,
  serializePromptLibrary,
  upsertPrompt,
  validatePrompt,
  MAX_PROMPTS,
  type SavedPrompt
} from '@/lib/prompt-library'

const KEY = 'swarmterm-prompts-v1'

/**
 * Saved prompts (SWA-23), persisted to local storage on every change. A
 * failed write keeps the previous list and reports an error rather than
 * pretending the prompt was saved.
 */
export interface PromptLibraryStore {
  prompts: SavedPrompt[]
  open: boolean
  error: string | null
  hydrate: () => void
  setOpen: (open: boolean) => void
  save: (prompt: SavedPrompt) => boolean
  remove: (id: string) => void
}

function write(prompts: SavedPrompt[]): boolean {
  try {
    localStorage.setItem(KEY, serializePromptLibrary(prompts))
    return true
  } catch {
    return false
  }
}

export const usePromptLibraryStore = create<PromptLibraryStore>((set, get) => ({
  prompts: [],
  open: false,
  error: null,
  hydrate: () => {
    try {
      set({ prompts: parsePromptLibrary(localStorage.getItem(KEY)) })
    } catch {
      set({ error: 'Could not load saved prompts.' })
    }
  },
  setOpen: (open) => set({ open, error: null }),
  save: (prompt) => {
    const invalid = validatePrompt(prompt)
    if (invalid) {
      set({ error: invalid })
      return false
    }
    const before = get().prompts
    const prompts = upsertPrompt(before, prompt)
    if (prompts === before) {
      set({ error: `The library is full (${MAX_PROMPTS} prompts). Delete one first.` })
      return false
    }
    if (!write(prompts)) {
      set({ error: 'Could not save the prompt.' })
      return false
    }
    set({ prompts, error: null })
    return true
  },
  remove: (id) => {
    const prompts = removePrompt(get().prompts, id)
    if (write(prompts)) set({ prompts, error: null })
    else set({ error: 'Could not delete the prompt.' })
  }
}))

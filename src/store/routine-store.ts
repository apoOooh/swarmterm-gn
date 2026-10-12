import { create } from 'zustand'
import {
  parseRoutines,
  removeRoutine,
  serializeRoutines,
  upsertRoutine,
  validateRoutine,
  MAX_ROUTINES,
  type Routine
} from '@/lib/routines'

const KEY = 'swarmterm-routines-v1'

/**
 * Routines (SWA-24), persisted to local storage on every change. Same
 * contract as the prompt library: a failed write keeps the previous list and
 * reports an error. `activeTerminalId` lives in memory only.
 */
export interface RoutineStore {
  routines: Routine[]
  open: boolean
  error: string | null
  hydrate: () => void
  setOpen: (open: boolean) => void
  save: (routine: Routine) => boolean
  remove: (id: string) => void
  /** Scheduler bookkeeping; never fails loudly (a lost write only risks one repeat). */
  patch: (id: string, change: Partial<Routine>) => void
}

function write(routines: Routine[]): boolean {
  try {
    localStorage.setItem(KEY, serializeRoutines(routines))
    return true
  } catch {
    return false
  }
}

export const useRoutineStore = create<RoutineStore>((set, get) => ({
  routines: [],
  open: false,
  error: null,
  hydrate: () => {
    try {
      set({ routines: parseRoutines(localStorage.getItem(KEY)) })
    } catch {
      set({ error: 'Could not load routines.' })
    }
  },
  setOpen: (open) => set({ open, error: null }),
  save: (routine) => {
    const invalid = validateRoutine(routine)
    if (invalid) {
      set({ error: invalid })
      return false
    }
    const before = get().routines
    const prev = before.find((r) => r.id === routine.id)
    // Editing the schedule or switching a routine on starts counting from now:
    // a change must never trigger a catch-up of slots that predate it.
    const restart = !prev || (!prev.enabled && routine.enabled) || JSON.stringify(prev.schedule) !== JSON.stringify(routine.schedule)
    const next = { ...routine, activeTerminalId: prev?.activeTerminalId, ...(restart ? { lastScheduledAt: Date.now() } : {}) }
    const routines = upsertRoutine(before, next)
    if (routines === before) {
      set({ error: `Too many routines (${MAX_ROUTINES}). Delete one first.` })
      return false
    }
    if (!write(routines)) {
      set({ error: 'Could not save the routine.' })
      return false
    }
    set({ routines, error: null })
    return true
  },
  remove: (id) => {
    const routines = removeRoutine(get().routines, id)
    if (write(routines)) set({ routines, error: null })
    else set({ error: 'Could not delete the routine.' })
  },
  patch: (id, change) => {
    const routines = get().routines.map((r) => (r.id === id ? { ...r, ...change } : r))
    write(routines)
    set({ routines })
  }
}))

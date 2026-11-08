import { create } from 'zustand'

/** Which pane's identity dialog is open. One dialog serves every entry point
 *  (header icon slot, pane menus, navbar list), so they cannot drift. */
interface PaneIdentityDialogState {
  leafId: string | null
  open: (leafId: string) => void
  close: () => void
}

export const usePaneIdentityDialogStore = create<PaneIdentityDialogState>((set) => ({
  leafId: null,
  open: (leafId) => set({ leafId }),
  close: () => set({ leafId: null })
}))

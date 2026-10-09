import { create } from 'zustand'
interface Choice { label: string; value: string; destructive?: boolean }
export interface FileDialog { title: string; detail?: string; input?: string; choices: Choice[] }
interface DialogState { dialog: FileDialog | null; answer: (value: string | null) => void }
let resolve: ((value: string | null) => void) | undefined
export const useFileDialogStore = create<DialogState>((set) => ({
  dialog: null,
  answer: (value) => { const finish = resolve; resolve = undefined; set({ dialog: null }); finish?.(value) }
}))
let queue = Promise.resolve<unknown>(null)
export function fileDialog(dialog: FileDialog): Promise<string | null> {
  const next = queue.then(() => new Promise<string | null>((done) => {
    resolve = done; useFileDialogStore.setState({ dialog })
  }))
  queue = next.catch(() => null)
  return next
}

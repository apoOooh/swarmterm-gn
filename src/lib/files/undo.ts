import type { FileContext } from '@/tauri/files'
export type FileUndo =
  | { type: 'created'; context: FileContext; paths: string[] }
  | { type: 'renamed'; context: FileContext; from: string; to: string }
  | { type: 'moved'; source: FileContext; target: FileContext; pairs: { source: string; destination: string }[] }
  | { type: 'removed'; context: FileContext; snapshotIds: string[] }
export function appendUndo(stack: FileUndo[], action: FileUndo): FileUndo[] {
  return [...stack, action].slice(-50)
}

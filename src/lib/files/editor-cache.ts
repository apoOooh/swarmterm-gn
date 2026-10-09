import type { EditorState } from '@codemirror/state'
export const editorCache = new Map<string, { state: EditorState; scrollTop: number; scrollLeft: number }>()
export function collectEditorCache(keys: Set<string>): void {
  for (const key of editorCache.keys()) if (!keys.has(key.split('\u0000')[1])) editorCache.delete(key)
}

import { applyEol, classifyExternalChange, detectEol, toLf, type Eol } from './edit'
import type { FileContext, TextFile } from '@/tauri/files'
import { fileKind } from './tree'
import type { MarkdownMode } from '@/lib/markdown-pref'
import { previewKind } from './preview-kind'
export interface FileDocument {
  key: string; context: FileContext; path: string; kind: 'text' | 'image' | 'video'
  content: string; saved: string; version: string; eol: Eol; bom: boolean; readOnly: boolean
  dirty: boolean; saving: boolean; conflict?: TextFile; missing: boolean; revision: number
  mode: 'editor' | 'split' | 'preview'
  jump?: { line: number; column: number; token: number }
}
/** `markdownMode` applies to previewable files (Markdown, SVG, HTML); everything else opens in the editor. */
export function newDocument(context: FileContext, path: string, disk?: TextFile, markdownMode: MarkdownMode = 'preview'): FileDocument {
  const content = toLf(disk?.content ?? '')
  return { key: `${context.id}:${path}`, context, path, kind: fileKind(path), content, saved: content,
    version: disk?.version ?? '', eol: detectEol(disk?.content ?? ''), bom: disk?.bom ?? false,
    readOnly: disk?.binary === true || disk?.truncated === true, dirty: false, saving: false,
    missing: false, revision: 0, mode: previewKind(path) ? markdownMode : 'editor' }
}
export function editDocument(doc: FileDocument, content: string): FileDocument {
  const text = toLf(content)
  return { ...doc, content: text, dirty: text !== doc.saved }
}
export function diskChanged(doc: FileDocument, disk: TextFile): FileDocument {
  const action = classifyExternalChange(toLf(disk.content), doc.saved, doc.dirty)
  if (action === 'conflict') return { ...doc, conflict: disk, missing: false }
  if (action === 'reload') return { ...newDocument(doc.context, doc.path, disk), key: doc.key, mode: doc.mode, revision: doc.revision + 1 }
  return { ...doc, version: disk.version, conflict: undefined, missing: false, ...(doc.dirty ? {} : { eol: detectEol(disk.content), bom: disk.bom }) }
}
export const serializedDocument = (doc: FileDocument): string => applyEol(doc.content, doc.eol)

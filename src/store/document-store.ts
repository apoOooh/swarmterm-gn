import { create } from 'zustand'
import { readFile, writeFile, type FileContext, type FileChange } from '@/tauri/files'
import { FileWatchLease } from '@/lib/files/watch-lease'
import { useMarkdownPrefStore } from './markdown-pref-store'
import { diskChanged, editDocument, newDocument, serializedDocument, type FileDocument } from '@/lib/files/documents'
import { detectEol, toLf } from '@/lib/files/edit'
import { fileKind } from '@/lib/files/tree'
import { isSubPath, rebasePath } from '@/lib/files/ops'
import { foldPathCase } from '@/lib/files/paths'
import { fileDialog } from './file-dialog-store'

export interface PaneFiles { tabs: string[]; active: string | null; split: boolean; keyboard: 'file' | 'terminal' }
export const EMPTY_PANE_FILES: PaneFiles = { tabs: [], active: null, split: false, keyboard: 'terminal' }
const pathKey = (c: FileContext, p: string): string => `${c.id}:${foldPathCase(p.replace(/\\/g, '/'))}`
let openGeneration = 0
const opening = new Map<string, Promise<FileDocument>>()
const refreshGeneration = new Map<string, number>()
const leases = new Map<string, FileWatchLease>()
let livePanes: Set<string> | null = null
interface DocumentState {
  documents: Record<string, FileDocument>; panes: Record<string, PaneFiles>; error: string | null
  open: (paneId: string, context: FileContext, path: string, location?: { line: number; column: number }) => Promise<void>
  update: (key: string, content: string) => void
  save: (key: string) => Promise<boolean>
  reload: (key: string) => Promise<void>
  keepBuffer: (key: string) => void
  select: (paneId: string, key: string | null) => void
  keyboard: (paneId: string, owner: 'file' | 'terminal') => void
  split: (paneId: string) => void
  mode: (key: string, mode: FileDocument['mode']) => void
  close: (paneId: string, key: string) => Promise<void>
  move: (from: string, to: string, key: string) => void
  guardPaths: (paths: string[]) => Promise<boolean>
  guardPanes: (paneIds: string[]) => Promise<boolean>
  removePaths: (paths: string[]) => void
  remap: (from: string, to: string, context?: FileContext) => void
  changed: (change: FileChange) => Promise<void>
  collect: (paneIds: Set<string>) => void
}

async function confirmDocuments(keys: string[]): Promise<boolean> {
  for (const key of new Set(keys)) {
    const doc = useDocumentStore.getState().documents[key]
    if (!doc?.dirty) continue
    const choice = await fileDialog({ title: 'Unsaved changes', detail: doc.path,
      choices: [{ label: 'Save', value: 'save' }, { label: 'Discard', value: 'discard', destructive: true }] })
    if (!choice) return false
    if (choice === 'save' && !await useDocumentStore.getState().save(key)) return false
  }
  return true
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  documents: {}, panes: {}, error: null,
  open: async (paneId, context, path, location) => {
    const existing = Object.values(get().documents).find((d) => pathKey(d.context, d.path) === pathKey(context, path))
    const key = existing?.key ?? pathKey(context, path)
    try {
      let doc = get().documents[key]
      if (!doc) {
        let pending = opening.get(key)
        if (!pending) {
          pending = (async () => {
            const disk = fileKind(path) === 'text' ? await readFile(context.id, path) : undefined
            const next = { ...newDocument(context, path, disk, useMarkdownPrefStore.getState().prefs.defaultMode), key }
            return next
          })()
          opening.set(key, pending)
        }
        doc = await pending; opening.delete(key)
      }
      const ready = doc
      if (livePanes && !livePanes.has(paneId)) return
      set((s) => {
        const pane = s.panes[paneId] ?? EMPTY_PANE_FILES
        const document = s.documents[key] ?? ready
        return { documents: { ...s.documents, [key]: location ? { ...document, jump: { ...location, token: ++openGeneration } } : document }, panes: { ...s.panes, [paneId]: { ...pane, tabs: pane.tabs.includes(key) ? pane.tabs : [...pane.tabs, key], active: key, keyboard: 'file' } }, error: null }
      })
      if (!leases.has(key)) {
        const lease = new FileWatchLease(context.id, [path]); leases.set(key, lease)
        void lease.ready.catch((e) => set({ error: `Live changes unavailable: ${String(e)}` }))
      }
    } catch (e) { opening.delete(key); set({ error: String(e) }) }
  },
  update: (key, content) => set((s) => { const doc = s.documents[key]; return doc && !doc.readOnly ? { documents: { ...s.documents, [key]: editDocument(doc, content) } } : {} }),
  save: async (key) => {
    const doc = get().documents[key]
    if (!doc || doc.readOnly || doc.saving || doc.conflict || doc.missing) return false
    if (!doc.dirty) return true
    set((s) => ({ documents: { ...s.documents, [key]: { ...doc, saving: true } } }))
    try {
      const result = await writeFile(doc.context.id, doc.path, serializedDocument(doc), doc.version, doc.bom)
      set((s) => { const current = s.documents[key]; return current ? { documents: { ...s.documents, [key]: { ...current, saved: doc.content, dirty: current.content !== doc.content, version: result.version, saving: false, conflict: undefined } }, error: null } : {} })
      return true
    } catch (e) {
      set((s) => { const current = s.documents[key]; return { ...(current ? { documents: { ...s.documents, [key]: { ...current, saving: false } } } : {}), error: String(e) } })
      await get().changed({ contextId: doc.context.id, paths: [doc.path], gitChanged: false, rescan: false })
      return false
    }
  },
  reload: async (key) => {
    const doc = get().documents[key]; if (!doc) return
    try { const disk = await readFile(doc.context.id, doc.path); set((s) => { const current = s.documents[key]; return current && current.path === doc.path ? { documents: { ...s.documents, [key]: { ...newDocument(doc.context, doc.path, disk), key, mode: current.mode, revision: current.revision + 1 } }, error: null } : {} }) }
    catch (e) { set({ error: String(e) }) }
  },
  keepBuffer: (key) => set((s) => { const doc = s.documents[key]; if (!doc?.conflict) return {}; const disk = doc.conflict;
    return { documents: { ...s.documents, [key]: { ...doc, version: disk.version, saved: toLf(disk.content), dirty: doc.content !== toLf(disk.content), eol: detectEol(disk.content), bom: disk.bom, conflict: undefined } } }
  }),
  select: (paneId, key) => set((s) => ({ panes: { ...s.panes, [paneId]: { ...(s.panes[paneId] ?? EMPTY_PANE_FILES), active: key, keyboard: key ? 'file' : 'terminal' } } })),
  keyboard: (paneId, keyboard) => set((s) => s.panes[paneId]?.keyboard === keyboard ? s : ({ panes: { ...s.panes, [paneId]: { ...(s.panes[paneId] ?? EMPTY_PANE_FILES), keyboard } } })),
  split: (paneId) => set((s) => { const pane = s.panes[paneId] ?? EMPTY_PANE_FILES; return { panes: { ...s.panes, [paneId]: { ...pane, split: !pane.split } } } }),
  mode: (key, mode) => set((s) => ({ documents: { ...s.documents, [key]: { ...s.documents[key], mode } } })),
  close: async (paneId, key) => {
    const shared = Object.entries(get().panes).some(([id, p]) => id !== paneId && p.tabs.includes(key))
    if (!shared && !await confirmDocuments([key])) return
    set((s) => { const p = s.panes[paneId] ?? EMPTY_PANE_FILES; const tabs = p.tabs.filter((k) => k !== key); return { panes: { ...s.panes, [paneId]: { ...p, tabs, active: p.active === key ? tabs[Math.max(0, p.tabs.indexOf(key) - 1)] ?? null : p.active } } } })
    get().collect(new Set(Object.keys(get().panes)))
  },
  move: (from, to, key) => set((s) => {
    const a = s.panes[from] ?? EMPTY_PANE_FILES, b = s.panes[to] ?? EMPTY_PANE_FILES
    if (from === to || !a.tabs.includes(key)) return {}
    const tabs = a.tabs.filter((k) => k !== key)
    return { panes: { ...s.panes, [from]: { ...a, tabs, active: a.active === key ? tabs[0] ?? null : a.active }, [to]: { ...b, tabs: b.tabs.includes(key) ? b.tabs : [...b.tabs, key], active: key, keyboard: 'file' } } }
  }),
  guardPaths: (paths) => confirmDocuments(Object.values(get().documents).filter((d) => paths.some((p) => isSubPath(p, d.path))).map((d) => d.key)),
  guardPanes: (paneIds) => {
    const keys = paneIds.flatMap((id) => get().panes[id]?.tabs ?? []).filter((key) => !Object.entries(get().panes).some(([id, p]) => !paneIds.includes(id) && p.tabs.includes(key)))
    return confirmDocuments(keys)
  },
  removePaths: (paths) => set((s) => {
    const keys = new Set(Object.values(s.documents).filter((d) => paths.some((p) => isSubPath(p, d.path))).map((d) => d.key))
    const panes = Object.fromEntries(Object.entries(s.panes).map(([id, p]) => { const tabs = p.tabs.filter((k) => !keys.has(k)); return [id, { ...p, tabs, active: p.active && keys.has(p.active) ? tabs[0] ?? null : p.active }] }))
    return { panes }
  }),
  remap: (from, to, context) => set((s) => {
    const documents = { ...s.documents }
    for (const doc of Object.values(documents)) {
      if (!isSubPath(from, doc.path)) continue
      const path = rebasePath(doc.path, from, to)
      // Keys stay stable so cached CodeMirror history and cross-pane references survive renames.
      documents[doc.key] = { ...doc, path, context: context ?? doc.context }
      const lease = new FileWatchLease((context ?? doc.context).id, [path])
      leases.get(doc.key)?.release(); leases.set(doc.key, lease)
      void lease.ready.catch((e) => set({ error: `Live changes unavailable: ${String(e)}` }))
    }
    return { documents }
  }),
  changed: async (change) => {
    await Promise.all(Object.values(get().documents).filter((d) => d.context.id === change.contextId && (change.rescan || change.paths.some((p) => isSubPath(p, d.path) || isSubPath(d.path, p)))).map(async (doc) => {
      if (doc.kind !== 'text') { set((s) => { const current = s.documents[doc.key]; return current ? { documents: { ...s.documents, [doc.key]: { ...current, revision: current.revision + 1 } } } : {} }); return }
      const generation = ++openGeneration; refreshGeneration.set(doc.key, generation)
      try {
        const disk = await readFile(doc.context.id, doc.path)
        if (refreshGeneration.get(doc.key) !== generation) return
        set((s) => { const current = s.documents[doc.key]; if (!current || current.saving || current.version !== doc.version) return {}; return { documents: { ...s.documents, [doc.key]: diskChanged(current, disk) } } })
      } catch {
        if (refreshGeneration.get(doc.key) !== generation) return
        set((s) => { const current = s.documents[doc.key]; return current ? { documents: { ...s.documents, [doc.key]: { ...current, missing: true } } } : {} })
      }
    }))
  },
  collect: (live) => set((s) => {
    livePanes = live
    const panes = Object.fromEntries(Object.entries(s.panes).filter(([id]) => live.has(id)))
    const keys = new Set(Object.values(panes).flatMap((p) => p.tabs))
    const documents = Object.fromEntries(Object.entries(s.documents).filter(([key]) => {
      if (keys.has(key)) return true
      leases.get(key)?.release(); leases.delete(key); return false
    }))
    return { panes, documents }
  })
}))

import { create } from 'zustand'
import { getFileGitStatus, listFiles, openFileContext, type FileContext, type FileChange } from '@/tauri/files'
import { FileWatchLease } from '@/lib/files/watch-lease'
import type { Directory } from '@/lib/files/tree'
import { appendUndo, type FileUndo } from '@/lib/files/undo'
import { ancestorDirs, parentDir } from '@/lib/files/paths'
export interface ExplorerRoot {
  context: FileContext; dirs: Record<string, Directory>; expanded: string[]; selection: string[]
  active: string | null; anchor: string | null; statuses: Record<string, string>
}
interface ExplorerState {
  visible: boolean; current: string | null; roots: Record<string, ExplorerRoot>
  loading: boolean; error: string | null; notice: string | null; busy: boolean
  clipboard: { context: FileContext; paths: string[]; cut: boolean } | null
  undo: FileUndo[]
  remember: (action: FileUndo) => void
  follow: (terminalId: string | null, configuredRoot?: string) => Promise<void>
  load: (id: string, path: string) => Promise<void>
  refresh: (id?: string) => Promise<void>
  toggle: (id: string, path: string) => void
  select: (id: string, selection: string[], active: string, anchor?: string) => void
  changed: (change: FileChange) => Promise<void>
  /** Expand the folders down to `path`, select it and scroll it into view (terminal Ctrl+click). */
  reveal: (id: string, path: string) => Promise<void>
}
let generation = 0
let currentTerminal: string | null = null
let currentConfiguredRoot: string | undefined
let lease: FileWatchLease | undefined
const listingGeneration = new Map<string, number>()
const gitGeneration = new Map<string, number>()
let counter = 0
/** Drops folders (and everything below them) that no longer exist from the expansion state and the
 *  listing cache. A removed worktree or a folder deleted outside the app would otherwise stay
 *  expanded forever and fail every refresh with a "Retry" row. */
function forget(root: ExplorerRoot, gone: string[]): ExplorerRoot {
  if (gone.length === 0) return root
  const under = (p: string) => gone.some((g) => p === g || p.startsWith(g + '/') || p.startsWith(g + '\\'))
  return { ...root, expanded: root.expanded.filter((p) => !under(p)), dirs: Object.fromEntries(Object.entries(root.dirs).filter(([p]) => !under(p))) }
}
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
async function git(id: string): Promise<void> {
  const token = ++counter; gitGeneration.set(id, token)
  try {
    const changes = await getFileGitStatus(id)
    if (gitGeneration.get(id) !== token) return
    const root = useExplorerStore.getState().roots[id]
    if (!root) return
    const sep = root.context.root.includes('\\') ? '\\' : '/'
    const statuses = Object.fromEntries(changes.map((f) => [`${root.context.root.replace(/[/\\]$/, '')}${sep}${f.path.replace(/[/\\]/g, sep)}`, f.status]))
    useExplorerStore.setState((s) => ({ roots: { ...s.roots, [id]: { ...s.roots[id], statuses } } }))
  } catch { /* A non-git folder still has a fully functional explorer. */ }
}
export const useExplorerStore = create<ExplorerState>((set, get) => ({
  visible: true, current: null, roots: {}, loading: false, error: null, notice: null, busy: false, clipboard: null, undo: [],
  remember: (action) => set((s) => ({ undo: appendUndo(s.undo, action) })),
  follow: async (terminalId, configuredRoot) => {
    if (terminalId === currentTerminal && configuredRoot === currentConfiguredRoot && get().current) return
    currentTerminal = terminalId
    currentConfiguredRoot = configuredRoot
    const token = ++generation
    lease?.release(); lease = undefined
    set({ current: null, loading: terminalId !== null, error: null })
    if (!terminalId) return
    let lastError: unknown
    for (let attempt = 0; attempt < 20 && token === generation; attempt++) {
      try {
        // Rust compares canonical directories, so symlinked project folders are accepted too.
        const context = await openFileContext(terminalId, configuredRoot)
        if (token !== generation) return
        set((s) => ({ current: context.id, loading: false, roots: { ...s.roots, [context.id]: s.roots[context.id] ?? { context, dirs: {}, expanded: [], selection: [], active: null, anchor: null, statuses: {} } } }))
        try {
          const acquired = new FileWatchLease(context.id); lease = acquired
          await acquired.ready
          if (token !== generation) { acquired.release(); return }
        } catch (e) { if (token === generation) set({ notice: `Live refresh unavailable: ${String(e)}` }) }
        await get().refresh(context.id)
        return
      } catch (e) {
        lastError = e
        if (!String(e).toLowerCase().includes('not ready')) break
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    if (token === generation) set({ loading: false, error: String(lastError ?? 'Cannot open this project') })
  },
  load: async (id, path) => {
    const key = `${id}:${path}`; const token = ++counter; listingGeneration.set(key, token)
    const root = get().roots[id]; if (!root) return
    set((s) => ({ roots: { ...s.roots, [id]: { ...s.roots[id], dirs: { ...s.roots[id].dirs, [path]: { ...s.roots[id].dirs[path], loading: true, error: undefined } } } } }))
    try {
      const entries = await listFiles(id, path)
      if (listingGeneration.get(key) !== token) return
      entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || natural.compare(a.name, b.name))
      // Child folders the user had open but that this listing no longer contains are gone from disk.
      const present = new Set(entries.filter((e) => e.isDir).map((e) => e.path))
      set((s) => {
        const r = s.roots[id]; if (!r) return s
        const gone = [...new Set([...r.expanded, ...Object.keys(r.dirs)])].filter((p) => p !== path && parentDir(p) === path && !present.has(p))
        return { roots: { ...s.roots, [id]: forget({ ...r, dirs: { ...r.dirs, [path]: { entries } } }, gone) } }
      })
    } catch (e) {
      if (listingGeneration.get(key) !== token) return
      set((s) => {
        const r = s.roots[id]; if (!r) return s
        // Not error-worthy if the parent already proves the folder is gone (or a parent pruned it meanwhile).
        const parent = r.dirs[parentDir(path)]?.entries
        if (path !== r.context.root && (!r.expanded.includes(path) && !(path in r.dirs) || (parent && !parent.some((f) => f.path === path)))) return { roots: { ...s.roots, [id]: forget(r, [path]) } }
        return { roots: { ...s.roots, [id]: { ...r, dirs: { ...r.dirs, [path]: { error: String(e) } } } } }
      })
    }
  },
  refresh: async (id) => {
    const selected = id ?? get().current; if (!selected) return
    const root = get().roots[selected]; if (!root) return
    await Promise.all([get().load(selected, root.context.root), ...root.expanded.map((p) => get().load(selected, p)), git(selected)])
  },
  toggle: (id, path) => {
    const root = get().roots[id]; if (!root) return
    const expanded = root.expanded.includes(path) ? root.expanded.filter((p) => p !== path) : [...root.expanded, path]
    set((s) => ({ roots: { ...s.roots, [id]: { ...s.roots[id], expanded } } }))
    if (expanded.includes(path)) void get().load(id, path)
  },
  select: (id, selection, active, anchor) => set((s) => ({ roots: { ...s.roots, [id]: { ...s.roots[id], selection, active, anchor: anchor ?? s.roots[id].anchor } } })),
  reveal: async (id, path) => {
    const root = get().roots[id]; if (!root) return
    const dirs = ancestorDirs(root.context.root, path)
    if (dirs.length === 0) return
    const expanded = [...new Set([...root.expanded, ...dirs.slice(1)])]
    set((s) => ({ visible: true, roots: { ...s.roots, [id]: { ...s.roots[id], expanded, selection: [path], active: path, anchor: path } } }))
    // Listings must exist before the row does; load the chain in parallel, then scroll.
    await Promise.all(dirs.filter((d) => !get().roots[id]?.dirs[d]?.entries).map((d) => get().load(id, d)))
    window.dispatchEvent(new CustomEvent('swarmterm:reveal-file', { detail: path }))
  },
  changed: async (change) => {
    if (change.error) set({ notice: `Live refresh: ${change.error}` })
    const root = get().roots[change.contextId]; if (!root) return
    const dirs = Object.keys(root.dirs).filter((p) => change.rescan || change.paths.some((changed) => changed === p || changed.startsWith(p + '/') || changed.startsWith(p + '\\')))
    await Promise.all([...dirs.map((p) => get().load(change.contextId, p)), ...(change.gitChanged ? [git(change.contextId)] : [])])
  }
}))

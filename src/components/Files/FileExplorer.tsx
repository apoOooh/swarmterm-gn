import { FILE_DRAG_TYPE } from '@/lib/terminal-drop'
import { endExplorerDrag, startExplorerDrag, takeExplorerDrag } from '@/lib/explorer-drag'
import { devLog } from '@/lib/dev-log'
import { dropExplorerDragAt } from '@/components/FileDropListener'
import { useEffect, useRef, useState, type KeyboardEvent, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, ChevronsDownUp, Copy, File, FilePlus, Folder, FolderPlus, History, RefreshCw, X } from 'lucide-react'
import { useAppStore } from '@/store/app-store'
import { useExplorerStore, type ExplorerRoot } from '@/store/explorer-store'
import { useDocumentStore } from '@/store/document-store'
import { fileDialog } from '@/store/file-dialog-store'
import { collectLeaves } from '@/lib/layout-tree'
import { treeRows, virtualRange, gitBadge, type TreeRow } from '@/lib/files/tree'
import { rangeBetween } from '@/lib/files/selection'
import { topLevelOnly, validateName } from '@/lib/files/ops'
import { messageText } from '@/lib/files/messages'
import { parentDir } from '@/lib/files/paths'
import { isMacPlatform } from '@/lib/platform'
import { copyNativeFiles, createFile, importNativeFiles, listHistory, onFileProgress, readNativeFiles, removeFiles, renameFile, restoreSnapshot, revealFile, openInMarkText, transferFiles, type FileContext, type Snapshot, type TransferResult } from '@/tauri/files'
import { writeClipboard as writeClipboardText } from '@/tauri/clipboard'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ContextMenuSeparator } from '@/components/ui/context-menu-separator'
import { cn } from '@/lib/utils'
import { isMarkdownPath } from '@/lib/markdown-pref'
import { useMarkdownPrefStore } from '@/store/markdown-pref-store'

const rowHeight = 26
const basename = (path: string): string => path.replace(/\\/g, '/').split('/').pop() ?? path

export function FileExplorer(): React.ReactElement {
  const state = useAppStore()
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
  const leaf = ws ? collectLeaves(ws.layout).find((l) => l.id === ws.focusedLeafId) : undefined
  const explorer = useExplorerStore()
  const root = explorer.current ? explorer.roots[explorer.current] : undefined
  const tree = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(300)
  const [history, setHistory] = useState<Snapshot[] | null>(null)
  const [progress, setProgress] = useState('')
  const busyOperation = useRef<string | null>(null)
  const typeahead = useRef({ text: '', time: 0 })
  const documentError = useDocumentStore((s) => s.error)
  const terminalId = state.welcomeFocused ? null : leaf?.terminalId ?? null
  const configuredRoot = leaf?.cwd ?? ws?.cwd
  useEffect(() => { void useExplorerStore.getState().follow(terminalId, configuredRoot) }, [terminalId, configuredRoot])
  useEffect(() => {
    const el = tree.current; if (!el) return
    const observer = new ResizeObserver(() => setHeight(el.clientHeight))
    observer.observe(el); setHeight(el.clientHeight)
    return () => observer.disconnect()
  }, [root?.context.id, explorer.visible, history])
  useEffect(() => {
    setFilter(''); setScrollTop(0); setHistory(null)
    if (tree.current) tree.current.scrollTop = 0
  }, [root?.context.id])
  useEffect(() => {
    const listener = onFileProgress((e) => { if (e.operationId === busyOperation.current) setProgress(`${basename(e.path)} · ${(e.bytes / 1024 / 1024).toFixed(1)} MB`) })
    return () => { void listener.then((off) => off()) }
  }, [])
  useEffect(() => {
    const focus = (): void => { tree.current?.focus() }
    window.addEventListener('swarmterm:focus-explorer', focus)
    return () => window.removeEventListener('swarmterm:focus-explorer', focus)
  }, [])

  const rowsRef = useRef<TreeRow[]>([])
  useEffect(() => {
    const reveal = (e: Event): void => {
      const index = rowsRef.current.findIndex((r) => r.entry.path === (e as CustomEvent<string>).detail)
      if (index >= 0 && tree.current) tree.current.scrollTop = Math.max(0, index * rowHeight - tree.current.clientHeight / 2)
    }
    window.addEventListener('swarmterm:reveal-file', reveal)
    return () => window.removeEventListener('swarmterm:reveal-file', reveal)
  }, [])
  const rows = root ? treeRows(root.context.root, root.dirs, new Set(root.expanded), filter) : []
  rowsRef.current = rows
  const range = virtualRange(rows.length, scrollTop, height, rowHeight)
  const context = root?.context
  const activeEntry = rows.find((r) => r.entry.path === root?.active)?.entry
  const destination = context ? (activeEntry?.isDir ? activeEntry.path : activeEntry ? parentDir(activeEntry.path) : context.root) : ''
  const selection = topLevelOnly(root?.selection ?? [])

  async function operation(work: (id: string) => Promise<void>): Promise<void> {
    if (useExplorerStore.getState().busy) return
    const id = crypto.randomUUID(); busyOperation.current = id
    useExplorerStore.setState({ busy: true, notice: null, error: null }); setProgress('Working…')
    try { await work(id) }
    catch (e) { useExplorerStore.setState({ error: String(e) }) }
    finally {
      busyOperation.current = null; setProgress(''); useExplorerStore.setState({ busy: false })
      if (context) await useExplorerStore.getState().refresh(context.id)
    }
  }
  async function askName(title: string, initial: string): Promise<string | null> {
    const name = await fileDialog({ title, input: initial, choices: [{ label: 'Apply', value: 'apply' }] })
    if (name === null) return null
    const error = validateName(name)
    if (error) { useExplorerStore.setState({ error: messageText(error) }); return null }
    return name
  }
  async function create(isDir: boolean): Promise<void> {
    if (!context) return
    const name = await askName(isDir ? 'New folder' : 'New file', '')
    if (name === null) return
    await operation(async () => {
      const path = await createFile(context.id, destination, name, isDir)
      useExplorerStore.getState().remember({ type: 'created', context, paths: [path] })
      if (destination !== context.root && !root?.expanded.includes(destination)) useExplorerStore.getState().toggle(context.id, destination)
      useExplorerStore.getState().select(context.id, [path], path, path)
      if (!isDir && leaf) await useDocumentStore.getState().open(leaf.id, context, path)
    })
  }
  async function rename(): Promise<void> {
    if (!context || selection.length !== 1) return
    const source = selection[0]
    const name = await askName('Rename', basename(source)); if (name === null) return
    await operation(async () => {
      const dest = await renameFile(context.id, source, name)
      if (dest !== source) useExplorerStore.getState().remember({ type: 'renamed', context, from: source, to: dest })
      useDocumentStore.getState().remap(source, dest)
      useExplorerStore.getState().select(context.id, [dest], dest, dest)
    })
  }
  async function remove(): Promise<void> {
    if (!context || !selection.length) return
    const approved = await fileDialog({ title: `Delete ${selection.length === 1 ? basename(selection[0]) : `${selection.length} items`}?`,
      detail: 'Explorer deletions are saved to local history when they fit its limits (50 MB / 5,000 entries per snapshot).',
      choices: [{ label: 'Delete', value: 'delete', destructive: true }] })
    if (!approved || !await useDocumentStore.getState().guardPaths(selection)) return
    await operation(async () => {
      const result = await removeFiles(context.id, selection)
      const snapshotIds = result.snapshots.filter((s) => result.removed.includes(s.path)).map((s) => s.id)
      if (snapshotIds.length) useExplorerStore.getState().remember({ type: 'removed', context, snapshotIds })
      useDocumentStore.getState().removePaths(result.removed)
      useDocumentStore.getState().collect(new Set(state.workspaces.flatMap((w) => collectLeaves(w.layout).map((l) => l.id))))
      useExplorerStore.getState().select(context.id, [], context.root)
      useExplorerStore.setState({ notice: result.warnings.length ? result.warnings.join('\n') : `Deleted ${result.removed.length} item(s). Restore from local history or press ${isMacPlatform() ? 'Cmd' : 'Ctrl'}+Z.` })
    })
  }
  async function copy(cut: boolean): Promise<void> {
    if (!context || !selection.length) return
    useExplorerStore.setState({ clipboard: { context, paths: selection, cut } })
    if (!cut) {
      try { await copyNativeFiles(context.id, selection) }
      catch (e) { useExplorerStore.setState({ notice: `Copied inside Swarmterm. Native clipboard: ${String(e)}` }) }
    }
  }
  function transferred(result: TransferResult, source: FileContext | null, target: FileContext, cut: boolean): void {
    if (result.completed.length) {
      useExplorerStore.getState().remember(cut && source ? { type: 'moved', source, target, pairs: result.completed } : { type: 'created', context: target, paths: result.completed.map((p) => p.destination) })
    }
    if (cut) for (const moved of result.completed) useDocumentStore.getState().remap(moved.source, moved.destination, target)
    if (result.errors.length) useExplorerStore.setState({ error: result.errors.join('\n') })
    else useExplorerStore.setState({ notice: `${cut ? 'Moved' : 'Copied'} ${result.completed.length} item(s).` })
    // Retain only the failed cut sources, so a retry does not move completed sources twice.
    if (cut && source) {
      const clipboard = useExplorerStore.getState().clipboard
      if (clipboard?.cut) {
        const done = new Set(result.completed.map((c) => c.source))
        const paths = clipboard.paths.filter((p) => !done.has(p))
        useExplorerStore.setState({ clipboard: paths.length ? { ...clipboard, paths } : null })
      }
    }
  }
  async function paste(native = false): Promise<void> {
    if (!context) return
    const clipboard = useExplorerStore.getState().clipboard
    if (!native && clipboard) {
      await operation(async (id) => transferred(await transferFiles(context.id, clipboard.context.id, clipboard.paths, destination, clipboard.cut, id), clipboard.context, context, clipboard.cut))
    } else {
      await operation(async (id) => {
        const paths = await readNativeFiles()
        const approved = await fileDialog({ title: 'Import files from the system clipboard?', detail: `${paths.length} item(s) will be copied to ${destination}.`, choices: [{ label: 'Import', value: 'import' }] })
        if (!approved) return
        transferred(await importNativeFiles(context.id, destination, id, paths), null, context, false)
      })
    }
  }
  async function duplicate(): Promise<void> {
    if (!context || !selection.length) return
    await operation(async (id) => {
      for (const path of selection) transferred(await transferFiles(context.id, context.id, [path], parentDir(path), false, id), context, context, false)
    })
  }
  async function restore(id?: string): Promise<void> {
    if (!context) return
    await operation(async () => {
      const selected = id ?? (await listHistory(context.id))[0]?.id
      if (!selected) { useExplorerStore.setState({ notice: 'No deletion snapshots available.' }); return }
      const path = await restoreSnapshot(context.id, selected)
      useExplorerStore.setState({ notice: `Restored ${basename(path)}.` })
      if (history) setHistory(await listHistory(context.id))
    })
  }
  async function showHistory(): Promise<void> {
    if (!context) return
    if (history) { setHistory(null); return }
    await operation(async () => setHistory(await listHistory(context.id)))
  }
  async function undo(): Promise<void> {
    const action = useExplorerStore.getState().undo.at(-1)
    if (!action) { useExplorerStore.setState({ notice: 'Nothing to undo.' }); return }
    const paths = action.type === 'created' ? action.paths : action.type === 'renamed' ? [action.to] : []
    if (paths.length && !await useDocumentStore.getState().guardPaths(paths)) return
    await operation(async (id) => {
      if (action.type === 'created') {
        const result = await removeFiles(action.context.id, action.paths)
        useDocumentStore.getState().removePaths(result.removed)
        action.paths = action.paths.filter((p) => !result.removed.includes(p))
        if (action.paths.length) throw new Error(result.warnings.join('\n') || 'Undo did not remove all created items.')
      } else if (action.type === 'renamed') {
        const path = await renameFile(action.context.id, action.to, basename(action.from))
        useDocumentStore.getState().remap(action.to, path)
      } else if (action.type === 'removed') {
        for (const snapshotId of [...action.snapshotIds]) {
          await restoreSnapshot(action.context.id, snapshotId)
          action.snapshotIds = action.snapshotIds.filter((p) => p !== snapshotId)
        }
      } else {
        for (const pair of [...action.pairs].reverse()) {
          const result = await transferFiles(action.source.id, action.target.id, [pair.destination], parentDir(pair.source), true, id)
          if (result.errors.length) throw new Error(result.errors.join('\n'))
          if (result.completed[0]) useDocumentStore.getState().remap(pair.destination, result.completed[0].destination, action.source)
          action.pairs = action.pairs.filter((p) => p !== pair)
        }
      }
      useExplorerStore.setState((s) => ({ undo: s.undo.filter((a) => a !== action), notice: 'File operation undone.' }))
      await useExplorerStore.getState().refresh(action.type === 'moved' ? action.source.id : action.context.id)
    })
  }
  function selectRow(row: TreeRow, shift: boolean, toggle: boolean): void {
    if (!root) return
    const path = row.entry.path
    const next = shift && root.anchor ? rangeBetween(rows.map((r) => r.entry.path), root.anchor, path) : toggle ? (root.selection.includes(path) ? root.selection.filter((p) => p !== path) : [...root.selection, path]) : [path]
    useExplorerStore.getState().select(root.context.id, next, path, shift ? undefined : path)
    tree.current?.focus()
  }
  function open(row: TreeRow): void {
    if (!context) return
    if (row.entry.isDir) useExplorerStore.getState().toggle(context.id, row.entry.path)
    else if (leaf) void useDocumentStore.getState().open(leaf.id, context, row.entry.path)
  }
  function keyboard(e: KeyboardEvent): void {
    if (!root || e.target !== e.currentTarget) return
    const mod = isMacPlatform() ? e.metaKey : e.ctrlKey
    const index = rows.findIndex((r) => r.entry.path === root.active)
    const row = rows[index]
    const key = e.key.toLowerCase()
    if (mod && ['a', 'c', 'x', 'v', 'z'].includes(key)) {
      e.preventDefault(); e.stopPropagation()
      if (key === 'a') useExplorerStore.getState().select(root.context.id, rows.map((r) => r.entry.path), root.active ?? rows[0]?.entry.path ?? root.context.root)
      if (key === 'c') void copy(false)
      if (key === 'x') void copy(true)
      if (key === 'v') void paste(e.shiftKey)
      if (key === 'z') void undo()
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Enter', 'F2', 'Delete'].includes(e.key)) { e.preventDefault(); e.stopPropagation() }
    let next = index
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1)
    if (e.key === 'ArrowUp') next = Math.max(0, index - 1)
    if (e.key === 'Home') next = 0
    if (e.key === 'End') next = rows.length - 1
    if (e.key === 'ArrowRight' && row?.entry.isDir) { if (!row.expanded) open(row); else next = Math.min(index + 1, rows.length - 1) }
    if (e.key === 'ArrowLeft' && row) { if (row.expanded) open(row); else next = rows.findIndex((r) => r.entry.path === row.parent) }
    if (e.key === 'Enter' && row) open(row)
    if (e.key === 'F2') void rename()
    if (e.key === 'Delete') void remove()
    if (!mod && !e.altKey && e.key.length === 1) {
      const now = Date.now(); typeahead.current.text = (now - typeahead.current.time < 700 ? typeahead.current.text : '') + e.key.toLowerCase(); typeahead.current.time = now
      next = rows.findIndex((r, i) => i > index && r.entry.name.toLowerCase().startsWith(typeahead.current.text))
      if (next < 0) next = rows.findIndex((r) => r.entry.name.toLowerCase().startsWith(typeahead.current.text))
    }
    if (next !== index && rows[next]) {
      selectRow(rows[next], e.shiftKey, false)
      const top = next * rowHeight
      if (tree.current && (top < scrollTop || top + rowHeight > scrollTop + height)) tree.current.scrollTop = Math.max(0, top - height / 2)
    }
  }
  function drop(e: DragEvent, directory: string): void {
    if (!context || !e.dataTransfer.types.includes(FILE_DRAG_TYPE)) return
    // Landed in the explorer itself: no terminal may type these paths afterwards.
    takeExplorerDrag()
    e.preventDefault(); e.stopPropagation()
    try {
      const data = JSON.parse(e.dataTransfer.getData(FILE_DRAG_TYPE)) as { contextId: string; paths: string[] }
      const source = useExplorerStore.getState().roots[data.contextId]?.context
      if (!source || !Array.isArray(data.paths)) return
      const cut = !(e.ctrlKey || e.metaKey)
      void operation(async (id) => transferred(await transferFiles(context.id, source.id, topLevelOnly(data.paths), directory, cut, id), source, context, cut))
    } catch (error) { useExplorerStore.setState({ error: String(error) }) }
  }
  function menu(): React.ReactElement {
    return <ContextMenuContent>
      <ContextMenuItem onSelect={() => void create(false)}>New file</ContextMenuItem>
      <ContextMenuItem onSelect={() => void create(true)}>New folder</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!selection.length} onSelect={() => void copy(false)}>Copy</ContextMenuItem>
      <ContextMenuItem disabled={!selection.length} onSelect={() => void copy(true)}>Cut</ContextMenuItem>
      <ContextMenuItem onSelect={() => void paste()}>Paste</ContextMenuItem>
      <ContextMenuItem onSelect={() => void paste(true)}>Paste from system clipboard</ContextMenuItem>
      <ContextMenuItem disabled={!selection.length} onSelect={() => void duplicate()}>Duplicate</ContextMenuItem>
      <ContextMenuItem disabled={selection.length !== 1} onSelect={() => void rename()}>Rename</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void writeClipboardText(selection.join('\n') || context?.root || '').catch((e) => useExplorerStore.setState({ error: String(e) }))}>Copy full path</ContextMenuItem>
      <ContextMenuItem onSelect={() => void writeClipboardText(selection.map((p) => p.slice((context?.root.length ?? 0) + 1)).join('\n')).catch((e) => useExplorerStore.setState({ error: String(e) }))}>Copy relative path</ContextMenuItem>
      <ContextMenuItem onSelect={() => { if (context) void revealFile(context.id, selection[0] ?? context.root).catch((e) => useExplorerStore.setState({ error: String(e) })) }}>Reveal in file manager</ContextMenuItem>
      <ContextMenuItem disabled={selection.length !== 1 || !isMarkdownPath(selection[0])} onSelect={() => { if (context) void openInMarkText(context.id, selection[0], useMarkdownPrefStore.getState().prefs.marktextPath).catch((e) => useExplorerStore.setState({ error: String(e) })) }}>Open in MarkText</ContextMenuItem>
      <ContextMenuItem onSelect={() => void showHistory()}>Local deletion history</ContextMenuItem>
      <ContextMenuItem disabled={!explorer.undo.length} onSelect={() => void undo()}>Undo file operation</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!selection.length} className="text-destructive" onSelect={() => void remove()}>Delete</ContextMenuItem>
    </ContextMenuContent>
  }
  return <section data-keyboard-owner="explorer" className="flex h-full min-h-0 flex-col border-t border-border" aria-label="File explorer">
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/40 px-2 py-1.5">
      <button className="flex-1 text-left text-[11px] font-semibold uppercase tracking-wider" onClick={() => useExplorerStore.setState({ visible: !explorer.visible })} aria-expanded={explorer.visible}>Files</button>
      <Tool title="New file" disabled={!context || explorer.busy} onClick={() => void create(false)}><FilePlus size={14} /></Tool>
      <Tool title="New folder" disabled={!context || explorer.busy} onClick={() => void create(true)}><FolderPlus size={14} /></Tool>
      <Tool title="Refresh files" disabled={!context || explorer.busy} onClick={() => void explorer.refresh()}><RefreshCw size={14} /></Tool>
      <Tool title="Collapse folders" disabled={!root} onClick={() => { if (root) useExplorerStore.setState((s) => ({ roots: { ...s.roots, [root.context.id]: { ...s.roots[root.context.id], expanded: [] } } })) }}><ChevronsDownUp size={14} /></Tool>
      <Tool title="Local deletion history" disabled={!context || explorer.busy} onClick={() => void showHistory()}><History size={14} /></Tool>
    </div>
    {explorer.visible && <>
      {context && <div className="shrink-0 truncate px-2 py-1 text-[11px] text-muted-foreground" title={context.root}>{context.root}</div>}
      {(explorer.error || documentError || explorer.notice) && <div role={explorer.error || documentError ? 'alert' : 'status'} className="flex shrink-0 gap-1 border-b border-border p-2 text-[11px]">
        <span className={cn('max-h-24 flex-1 overflow-auto whitespace-pre-wrap break-words', (explorer.error || documentError) && 'text-destructive')}>{explorer.error ?? documentError ?? explorer.notice}</span>
        <Tool title="Dismiss file message" onClick={() => { useExplorerStore.setState({ error: null, notice: null }); useDocumentStore.setState({ error: null }) }}><X size={12} /></Tool>
      </div>}
      {explorer.busy && <p role="status" className="shrink-0 px-2 py-1 text-[11px] text-muted-foreground">{progress}</p>}
      {history ? <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="mb-2 flex items-center justify-between text-xs"><span>Local deletion history</span><Tool title="Close history" onClick={() => setHistory(null)}><X size={14} /></Tool></div>
        <p className="mb-2 text-[10px] text-muted-foreground">30 days · 200 MB per project. Restores use a unique name.</p>
        {history.length === 0 && <p className="text-xs text-muted-foreground">No deletion snapshots.</p>}
        {history.map((s) => <button key={s.id} className="mb-1 flex w-full items-center gap-2 rounded p-2 text-left text-xs hover:bg-accent" title={s.path} onClick={() => void restore(s.id)}><History size={14} /><span className="min-w-0 flex-1 truncate">{basename(s.path)}<small className="block text-[10px] text-muted-foreground">{new Date(s.created).toLocaleString()} · {(s.bytes / 1024).toFixed(1)} KB</small></span></button>)}
      </div> : <>
        {root && <input className="mx-2 mb-1 shrink-0 rounded border border-input bg-background px-2 py-1 text-[11px] outline-none focus:ring-1 focus:ring-ring" placeholder="Filter loaded files" aria-label="Filter loaded files" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div ref={tree} role="tree" aria-label="Project files" aria-multiselectable="true" aria-activedescendant={root?.active ? `file-row-${encodeURIComponent(root.active)}` : undefined} tabIndex={0} className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" onKeyDown={keyboard} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onDragOver={(e) => { if (e.dataTransfer.types.includes(FILE_DRAG_TYPE)) e.preventDefault() }} onDrop={(e) => drop(e, context?.root ?? '')} onContextMenu={(e) => { if (root && e.target === e.currentTarget) explorer.select(root.context.id, [], root.context.root, root.context.root) }}>
              {explorer.loading && <p className="p-3 text-xs text-muted-foreground">Connecting to terminal…</p>}
              {!root && !explorer.loading && <p className="p-3 text-xs text-muted-foreground">Select a terminal to browse its project.</p>}
              {root?.dirs[root.context.root]?.error && <p role="alert" className="p-3 text-xs text-destructive">{root.dirs[root.context.root].error}</p>}
              {root && rows.length === 0 && !root.dirs[root.context.root]?.loading && <p className="p-3 text-xs text-muted-foreground">{filter ? 'No loaded files match.' : 'This folder is empty.'}</p>}
              <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
                {rows.slice(range.start, range.end).map((row, offset) => <ExplorerRow key={row.entry.path} row={row} root={root!} index={range.start + offset} onSelect={(shift, mod) => selectRow(row, shift, mod)} onOpen={() => open(row)} onDrop={(e) => drop(e, row.entry.isDir ? row.entry.path : row.parent)} onContext={() => { if (!root?.selection.includes(row.entry.path)) selectRow(row, false, false) }} />)}
              </div>
              {root && root.expanded.map((p) => root.dirs[p]?.error ? <button key={p} className="m-2 text-[11px] text-destructive" onClick={() => void explorer.load(root.context.id, p)}>Retry {basename(p)}: {root.dirs[p].error}</button> : null)}
            </div>
          </ContextMenuTrigger>
          {menu()}
        </ContextMenu>
      </>}
    </>}
  </section>
}

function ExplorerRow({ row, root, index, onSelect, onOpen, onDrop, onContext }: { row: TreeRow; root: ExplorerRoot; index: number; onSelect: (shift: boolean, mod: boolean) => void; onOpen: () => void; onDrop: (e: DragEvent) => void; onContext: () => void }): React.ReactElement {
  const selected = root.selection.includes(row.entry.path)
  const status = gitBadge(row.entry.path, root.statuses)
  return <div id={`file-row-${encodeURIComponent(row.entry.path)}`} role="treeitem" aria-level={row.depth + 1} aria-selected={selected} aria-expanded={row.entry.isDir ? row.expanded : undefined} title={`${row.entry.path}${row.entry.isSymlink ? ' (symbolic link)' : ''}`} draggable className={cn('absolute left-0 right-0 flex cursor-default items-center gap-1.5 pr-2 text-xs hover:bg-accent/40', selected && 'bg-accent text-accent-foreground', root.active === row.entry.path && 'outline outline-1 -outline-offset-1 outline-ring/50')} style={{ top: index * rowHeight, height: rowHeight, paddingLeft: 8 + row.depth * 14 }} onContextMenu={onContext} onClick={(e) => { onSelect(e.shiftKey, isMacPlatform() ? e.metaKey : e.ctrlKey); if (!e.shiftKey && !e.ctrlKey && !e.metaKey) onOpen() }} onDragStart={(e) => {
    const paths = selected ? root.selection : [row.entry.path]
    e.dataTransfer.setData(FILE_DRAG_TYPE, JSON.stringify({ contextId: root.context.id, paths: topLevelOnly(paths) })); e.dataTransfer.effectAllowed = 'copyMove'
    startExplorerDrag(topLevelOnly(paths))
    devLog('explorer.dragstart', { paths: topLevelOnly(paths), types: [...e.dataTransfer.types] })
    // dnd-kit must not interpret a native file drag as a terminal-pane gesture.
    e.stopPropagation()
  }} onDragEnd={(e) => { devLog('explorer.dragend', { dropEffect: e.dataTransfer.dropEffect, x: e.clientX, y: e.clientY }); dropExplorerDragAt({ x: e.clientX, y: e.clientY }); endExplorerDrag() }} onDragOver={(e) => { if (e.dataTransfer.types.includes(FILE_DRAG_TYPE)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? 'copy' : 'move' } }} onDrop={onDrop}>
    {row.entry.isDir ? (row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="w-3" />}
    {row.entry.isDir ? <Folder size={14} className="shrink-0 text-muted-foreground" /> : <File size={14} className="shrink-0 text-muted-foreground" />}
    <span className="min-w-0 flex-1 truncate">{row.entry.name}</span>
    {row.entry.isSymlink && <Copy size={10} className="text-muted-foreground" />}
    {root.dirs[row.entry.path]?.loading && <span className="animate-pulse text-muted-foreground">…</span>}
    {status && <span aria-label={`Git ${status}`} className={cn('font-mono text-[10px]', status === 'D' || status === 'U' ? 'text-destructive' : status === '?' || status === 'A' ? 'text-green-500' : 'text-amber-500')}>{status}</span>}
  </div>
}
function Tool({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return <button type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40">{children}</button>
}

import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from 'react'
import { File, PanelsTopLeft, Terminal, X } from 'lucide-react'
import { TerminalPane } from '@/components/TerminalPane/TerminalPane'
import { EMPTY_PANE_FILES, useDocumentStore } from '@/store/document-store'
import { useAppStore } from '@/store/app-store'
import { refitAttachedTerminals, focusTerminal } from '@/lib/terminal-registry'
import { cn } from '@/lib/utils'

const TAB_DRAG_TYPE = 'application/x-swarmterm-file-tab'
const FileView = lazy(() => import('./FileView').then((module) => ({ default: module.FileView })))
export function PaneWorkbench(props: ComponentProps<typeof TerminalPane>): React.ReactElement {
  const { leaf } = props
  const pane = useDocumentStore((s) => s.panes[leaf.id] ?? EMPTY_PANE_FILES)
  const documents = useDocumentStore((s) => s.documents)
  const active = pane.active ? documents[pane.active] : undefined
  const store = useDocumentStore.getState()
  const fileOwnsKeyboard = !!active && pane.keyboard !== 'terminal'
  const terminalVisible = !active || pane.split
  const [terminalShare, setTerminalShare] = useState(50)
  const splitHost = useRef<HTMLDivElement>(null)
  const resizing = useRef(false)
  useEffect(() => { if (terminalVisible) requestAnimationFrame(refitAttachedTerminals) }, [terminalVisible, pane.split])
  function select(key: string | null): void {
    useAppStore.getState().setFocusedLeaf(leaf.id)
    useDocumentStore.getState().select(leaf.id, key)
    if (!key) requestAnimationFrame(() => focusTerminal(leaf.terminalId))
  }
  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md" data-workbench-leaf={leaf.id} onDragOver={(e) => { if (e.dataTransfer.types.includes(TAB_DRAG_TYPE)) { e.preventDefault(); e.stopPropagation() } }} onDrop={(e) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
    e.preventDefault(); e.stopPropagation()
    try { const data = JSON.parse(e.dataTransfer.getData(TAB_DRAG_TYPE)) as { paneId: string; key: string }; store.move(data.paneId, leaf.id, data.key); useAppStore.getState().setFocusedLeaf(leaf.id) } catch { /* An unrelated native drag is ignored. */ }
  }}>
    {pane.tabs.length > 0 && <div role="tablist" aria-label="Pane tabs" data-keyboard-owner="editor" className="flex h-[var(--pane-tabbar-h)] shrink-0 items-center gap-0.5 overflow-x-auto border border-b-0 border-border bg-card px-1">
      <button role="tab" aria-selected={!active} className={cn('flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent', !active && 'bg-accent')} onClick={() => select(null)}><Terminal size={12} />Terminal</button>
      {pane.tabs.map((key) => {
        const doc = documents[key]; if (!doc) return null
        return <div key={key} draggable onDragStart={(e) => { e.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify({ paneId: leaf.id, key })); e.stopPropagation() }} className={cn('flex shrink-0 items-center rounded text-xs hover:bg-accent', pane.active === key && 'bg-accent')}>
          <button role="tab" aria-selected={pane.active === key} title={doc.path} className="flex max-w-48 items-center gap-1 px-2 py-1" onClick={() => select(key)}><File size={12} /><span className="truncate">{doc.path.replace(/\\/g, '/').split('/').pop()}</span>{doc.dirty && <span aria-label="Unsaved">●</span>}</button>
          <button title={`Close ${doc.path.replace(/\\/g, '/').split('/').pop()}`} aria-label={`Close file ${doc.path.replace(/\\/g, '/').split('/').pop()}`} className="mr-1 rounded p-0.5 hover:bg-background" onClick={() => void store.close(leaf.id, key)}><X size={12} /></button>
        </div>
      })}
      <button title="Show terminal and editor side by side" aria-label="Split terminal and editor" aria-pressed={pane.split} className="ml-auto shrink-0 rounded p-1 hover:bg-accent" onClick={() => store.split(leaf.id)}><PanelsTopLeft size={14} /></button>
    </div>}
    <div ref={splitHost} className="flex min-h-0 flex-1">
      <div className="h-full min-w-0 shrink-0" style={{ display: terminalVisible ? 'block' : 'none', width: active && pane.split ? `${terminalShare}%` : '100%' }} onMouseDownCapture={() => store.keyboard(leaf.id, 'terminal')}>
        <TerminalPane {...props} isFocused={props.isFocused && !fileOwnsKeyboard} />
      </div>
      {active && pane.split && <div role="separator" aria-label="Resize terminal and editor" aria-orientation="vertical" tabIndex={0} className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-ring focus:bg-ring" onPointerDown={(e) => { resizing.current = true; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={(e) => { if (!resizing.current || !splitHost.current) return; const rect = splitHost.current.getBoundingClientRect(); setTerminalShare(Math.max(15, Math.min(85, (e.clientX - rect.left) / rect.width * 100))) }} onPointerUp={(e) => { resizing.current = false; e.currentTarget.releasePointerCapture(e.pointerId) }} onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setTerminalShare((s) => Math.max(15, Math.min(85, s + (e.key === 'ArrowRight' ? 5 : -5)))) } }} />}
      {active && <div className="h-full min-w-0 flex-1" onMouseDownCapture={() => store.keyboard(leaf.id, 'file')}>
        <Suspense fallback={<p className="p-3 text-xs text-muted-foreground">Opening file…</p>}><FileView key={active.key} doc={active} leaf={leaf} focused={props.isFocused && fileOwnsKeyboard} /></Suspense>
      </div>}
    </div>
  </div>
}

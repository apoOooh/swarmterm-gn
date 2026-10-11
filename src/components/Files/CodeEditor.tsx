import { useEffect, useRef, type MutableRefObject } from 'react'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState, StateEffect, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { languageForExt } from '@/lib/files/edit'
import type { FileDocument } from '@/lib/files/documents'
import { useDocumentStore } from '@/store/document-store'
import { editorCache as cache } from '@/lib/files/editor-cache'

export async function language(path: string): Promise<Extension> {
  switch (languageForExt(path)) {
    case 'javascript': return (await import('@codemirror/lang-javascript')).javascript({ typescript: /\.[cm]?tsx?$/i.test(path), jsx: /\.[jt]sx$/i.test(path) })
    case 'python': return (await import('@codemirror/lang-python')).python()
    case 'json': return (await import('@codemirror/lang-json')).json()
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown()
    case 'html': return (await import('@codemirror/lang-html')).html()
    case 'css': return (await import('@codemirror/lang-css')).css()
    case 'xml': return (await import('@codemirror/lang-xml')).xml()
    case 'sql': return (await import('@codemirror/lang-sql')).sql()
    case 'cpp': return (await import('@codemirror/lang-cpp')).cpp()
    case 'java': return (await import('@codemirror/lang-java')).java()
    case 'rust': return (await import('@codemirror/lang-rust')).rust()
    case 'php': return (await import('@codemirror/lang-php')).php()
    case 'go': return (await import('@codemirror/lang-go')).go()
    case 'yaml': return (await import('@codemirror/lang-yaml')).yaml()
    default: return []
  }
}
const editorTheme = EditorView.theme({
  '&': { height: '100%', color: 'rgb(var(--color-foreground))', backgroundColor: 'rgb(var(--color-background))', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono, monospace)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'rgb(var(--color-foreground))' },
  '.cm-gutters': { color: 'rgb(var(--color-muted-foreground))', backgroundColor: 'rgb(var(--color-card))', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgb(var(--color-accent) / .25)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgb(var(--color-accent) / .7)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--color-foreground))' },
  '.cm-panels, .cm-tooltip': { backgroundColor: 'rgb(var(--color-card))', color: 'rgb(var(--color-foreground))', borderColor: 'rgb(var(--color-border))' },
  '.cm-textfield, .cm-button': { background: 'rgb(var(--color-background))', color: 'rgb(var(--color-foreground))', border: '1px solid rgb(var(--color-border))', borderRadius: 'var(--radius-sm)' },
  '&.cm-focused': { outline: 'none' }, '.cm-searchMatch': { background: 'rgb(var(--color-primary) / .2)' },
  '.cm-searchMatch-selected': { background: 'rgb(var(--color-primary) / .4)' }
})
const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--md-keyword, #c586c0)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--md-string, #ce9178)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--md-number, #b5cea8)' },
  { tag: [tags.comment], color: 'var(--text-faint, #6a9955)' },
  { tag: [tags.function(tags.variableName)], color: 'var(--md-function, #dcdcaa)' },
  { tag: [tags.typeName, tags.className], color: 'var(--md-type, #4ec9b0)' },
  { tag: [tags.heading], color: 'var(--md-heading, #569cd6)', fontWeight: 'bold' },
  { tag: tags.link, color: 'var(--md-link, #569cd6)', textDecoration: 'underline' }
]))

export function CodeEditor({ doc, paneId, viewRef, onScroll }: { doc: FileDocument; paneId: string; viewRef: MutableRefObject<EditorView | null>; onScroll?: (line: number) => void }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const sync = useRef(false)
  const scroll = useRef(onScroll); scroll.current = onScroll
  const languageConfig = useRef(new Compartment())
  const readOnly = useRef(new Compartment())
  const cacheKey = `${paneId}\u0000${doc.key}`
  useEffect(() => {
    if (!host.current) return
    const cached = cache.get(cacheKey)
    const extensions = [basicSetup, editorTheme, highlighting, EditorView.lineWrapping,
      languageConfig.current.of([]), readOnly.current.of([EditorState.readOnly.of(doc.readOnly), EditorView.editable.of(!doc.readOnly)]),
      keymap.of([indentWithTab]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !sync.current) useDocumentStore.getState().update(doc.key, update.state.doc.toString())
      }),
      EditorView.domEventHandlers({ scroll: (_event, view) => {
        const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop)
        scroll.current?.(view.state.doc.lineAt(block.from).number)
      } })]
    const state = cached && cached.state.doc.toString() === doc.content ? cached.state : EditorState.create({ doc: doc.content, extensions })
    const view = new EditorView({ state, parent: host.current }); viewRef.current = view
    // Cached states carry old compartments and listeners; reconfigure while retaining history and selection.
    if (state === cached?.state) view.dispatch({ effects: StateEffect.reconfigure.of(extensions) })
    if (cached) { view.scrollDOM.scrollTop = cached.scrollTop; view.scrollDOM.scrollLeft = cached.scrollLeft }
    let live = true
    void language(doc.path).then((extension) => { if (live) view.dispatch({ effects: languageConfig.current.reconfigure(extension) }) })
    const focus = (): void => { if (host.current?.closest('[data-file-active="true"]') && !view.hasFocus) view.focus() }
    const search = (): void => { if (host.current?.closest('[data-file-active="true"]')) openSearchPanel(view) }
    window.addEventListener('swarmterm:focus-editor', focus); window.addEventListener('swarmterm:find-file', search)
    const timer = setTimeout(focus, 0)
    return () => {
      live = false; clearTimeout(timer); window.removeEventListener('swarmterm:focus-editor', focus); window.removeEventListener('swarmterm:find-file', search)
      cache.set(cacheKey, { state: view.state, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft })
      view.destroy(); if (viewRef.current === view) viewRef.current = null
    }
  }, [cacheKey, doc.revision])
  useEffect(() => {
    const view = viewRef.current; if (!view || view.state.doc.toString() === doc.content) return
    sync.current = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc.content } })
    sync.current = false
  }, [doc.content])
  useEffect(() => {
    const view = viewRef.current
    if (view) view.dispatch({ effects: readOnly.current.reconfigure([EditorState.readOnly.of(doc.readOnly), EditorView.editable.of(!doc.readOnly)]) })
  }, [doc.readOnly])
  useEffect(() => {
    const view = viewRef.current; if (!view || !doc.jump) return
    const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, doc.jump.line)))
    const anchor = Math.min(line.to, line.from + Math.max(0, doc.jump.column - 1))
    view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) })
  }, [doc.jump?.token])
  useEffect(() => {
    let live = true
    void language(doc.path).then((extension) => { if (live && viewRef.current) viewRef.current.dispatch({ effects: languageConfig.current.reconfigure(extension) }) })
    return () => { live = false }
  }, [doc.path])
  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-keyboard-owner="editor" aria-label={`Editor ${doc.path}`} />
}

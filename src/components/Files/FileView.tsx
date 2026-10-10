import { isValidElement, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { EditorView } from '@codemirror/view'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import rehypeRaw from 'rehype-raw'
import rehypeSlug from 'rehype-slug'
import { ExternalLink, Globe, Play, Save, Search } from 'lucide-react'
import { CodeEditor } from './CodeEditor'
import { MediaView } from './MediaView'
import { CodeFence } from './CodeFence'
import { SvgPreview } from './SvgPreview'
import { HtmlPreview } from './HtmlPreview'
import type { FileDocument } from '@/lib/files/documents'
import { parentDir, resolveRelative, decodeUriPath } from '@/lib/files/paths'
import { fileRun } from '@/lib/files/run'
import { markdownSearch } from '@/lib/files/markdown-search'
import { shellFlavor } from '@/lib/agent-spawn-command'
import { isWindowsPlatform } from '@/lib/platform'
import { useDocumentStore } from '@/store/document-store'
import { useAppStore } from '@/store/app-store'
import { useTerminalPrefStore } from '@/store/terminal-pref-store'
import { useMarkdownPrefStore } from '@/store/markdown-pref-store'
import { previewKind } from '@/lib/files/preview-kind'
import { mediaUrl, openInMarkText, openPreviewExternal } from '@/tauri/files'
import { openUrl } from '@/tauri/opener'
import type { LeafNode } from '@/lib/layout-tree'
import { cn } from '@/lib/utils'

export function FileView({ doc, leaf, focused }: { doc: FileDocument; leaf: LeafNode; focused: boolean }): React.ReactElement {
  const store = useDocumentStore()
  const view = useRef<EditorView | null>(null)
  const preview = useRef<HTMLDivElement>(null)
  const scrolling = useRef(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const [findCount, setFindCount] = useState(0)
  const findInput = useRef<HTMLInputElement>(null)
  const shellId = useTerminalPrefStore((s) => s.shellId)
  const runner = fileRun(doc.path, shellFlavor(leaf.shellId ?? shellId, isWindowsPlatform()))
  const kind = previewKind(doc.path)
  const markdown = kind === 'markdown'
  const kindLabel = kind === 'markdown' ? 'Markdown' : kind?.toUpperCase()
  useEffect(() => {
    const matches = preview.current?.querySelectorAll('[data-file-match]')
    setFindCount(matches?.length ?? 0)
    matches?.[findIndex]?.scrollIntoView({ block: 'nearest' })
  }, [findQuery, findIndex, doc.content, doc.mode])
  useEffect(() => { if (findOpen) findInput.current?.focus() }, [findOpen])
  function find(): void {
    if (doc.mode === 'preview' && markdown) setFindOpen(true)
    else window.dispatchEvent(new Event('swarmterm:find-file'))
  }
  function editorScroll(line: number): void {
    if (scrolling.current || doc.mode !== 'split' || !preview.current) return
    const blocks = Array.from(preview.current.querySelectorAll<HTMLElement>('[data-source-line]'))
    const nearest = blocks.filter((b) => Number(b.dataset.sourceLine) <= line).at(-1) ?? blocks[0]
    if (!nearest) return
    scrolling.current = true
    preview.current.scrollTop = nearest.offsetTop - preview.current.offsetTop
    requestAnimationFrame(() => { scrolling.current = false })
  }
  function previewScroll(): void {
    if (scrolling.current || doc.mode !== 'split' || !preview.current || !view.current) return
    const container = preview.current
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('[data-source-line]'))
    const block = blocks.find((b) => b.getBoundingClientRect().bottom >= container.getBoundingClientRect().top)
    if (!block) return
    const line = Math.max(1, Math.min(view.current.state.doc.lines, Number(block.dataset.sourceLine)))
    scrolling.current = true
    view.current.dispatch({ effects: EditorView.scrollIntoView(view.current.state.doc.line(line).from, { y: 'start' }) })
    requestAnimationFrame(() => { scrolling.current = false })
  }
  // MarkText reads the file from disk, so unsaved edits are saved first — the
  // same contract as Run. A refused save (conflict, read-only) aborts the hand-off.
  async function openMarkText(): Promise<void> {
    if (doc.dirty && !await store.save(doc.key)) return
    await openInMarkText(doc.context.id, doc.path, useMarkdownPrefStore.getState().prefs.marktextPath)
      .catch((e) => useDocumentStore.setState({ error: String(e) }))
  }
  // Same save-first contract: the browser reads the file from disk.
  async function openBrowser(): Promise<void> {
    if (doc.dirty && !await store.save(doc.key)) return
    await openPreviewExternal(doc.context.id, doc.path).catch((e) => useDocumentStore.setState({ error: String(e) }))
  }
  const code = <CodeEditor doc={doc} paneId={leaf.id} viewRef={view} onScroll={editorScroll} />
  const markdownComponents = useMemo<Components>(() => ({
      a: ({ href, children, node, ...props }) => <a {...props} href={href} data-source-line={node?.position?.start.line} onClick={(e) => {
        e.preventDefault()
        if (!href) return
        if (/^https?:/i.test(href)) { void openUrl(href).catch(() => {}); return }
        if (href.startsWith('#')) { const el = preview.current?.querySelector(`[id="${CSS.escape(decodeUriPath(href.slice(1)))}"]`); el?.scrollIntoView(); return }
        if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return
        void store.open(leaf.id, doc.context, resolveRelative(doc.path, decodeUriPath(href.split(/[?#]/)[0])))
      }}>{children}</a>,
      p: ({ node, ...props }) => <p {...props} data-source-line={node?.position?.start.line} />,
      h1: ({ node, ...props }) => <h1 {...props} data-source-line={node?.position?.start.line} />,
      h2: ({ node, ...props }) => <h2 {...props} data-source-line={node?.position?.start.line} />,
      h3: ({ node, ...props }) => <h3 {...props} data-source-line={node?.position?.start.line} />,
      pre: ({ node, children, ...props }) => {
        const code = isValidElement<{ children?: string; className?: string }>(children) ? children.props : undefined
        return <pre {...props} data-source-line={node?.position?.start.line}>{code && typeof code.children === 'string' ? <CodeFence code={code.children} lang={code.className?.replace(/^language-/, '') ?? ''} /> : children}</pre>
      },
      ul: ({ node, ...props }) => <ul {...props} data-source-line={node?.position?.start.line} />,
      ol: ({ node, ...props }) => <ol {...props} data-source-line={node?.position?.start.line} />,
      table: ({ node, ...props }) => <div className="overflow-auto" data-source-line={node?.position?.start.line}><table {...props} /></div>,
      blockquote: ({ node, ...props }) => <blockquote {...props} data-source-line={node?.position?.start.line} />,
      img: ({ node: _node, ...props }) => <img {...props} loading="lazy" onError={(e) => { e.currentTarget.alt = 'Image unavailable or outside this project' }} />
    }), [doc.key, doc.path, doc.context.id, leaf.id])
  const rendered = <div ref={preview} onScroll={previewScroll} tabIndex={0} data-keyboard-owner="editor" className="markdown-preview h-full overflow-auto outline-none" aria-label="Markdown preview">
    <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeSlug, [markdownSearch, { query: findQuery, active: findIndex }]]} urlTransform={(url, key) => {
      if (key === 'src' && !/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith('//')) return mediaUrl(doc.context.id, resolveRelative(doc.path, decodeUriPath(url.split(/[?#]/)[0])), doc.revision)
      return defaultUrlTransform(url)
    }} components={markdownComponents}>{doc.content}</ReactMarkdown></div>
  </div>
  const previewPane = markdown ? rendered : kind === 'svg' ? <SvgPreview content={doc.content} /> : kind === 'html' ? <HtmlPreview doc={doc} /> : null
  return <div data-keyboard-owner="editor" data-file-active={focused} className="flex h-full min-h-0 flex-col bg-background" onMouseDown={() => useAppStore.getState().setFocusedLeaf(leaf.id)} onKeyDown={(e) => {
    if (e.defaultPrevented) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); void store.save(doc.key) }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); find() }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v' && kind) { e.preventDefault(); e.stopPropagation(); store.mode(doc.key, doc.mode === 'editor' ? 'split' : doc.mode === 'split' ? 'preview' : 'editor') }
  }}>
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1 text-[11px]">
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={doc.path}>{doc.path}</span>
      {runner && <button title={runner.label} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent" onClick={async () => { if (doc.dirty && !await store.save(doc.key)) return; useAppStore.getState().runFileInPane(leaf.id, parentDir(doc.path), runner.command) }}><Play size={12} />Run</button>}
      {doc.kind === 'text' && <>
        <button title="Find / replace" aria-label="Find / replace" className="rounded p-1 hover:bg-accent" onClick={find}><Search size={13} /></button>
        <button title="Save (Ctrl/Cmd+S)" aria-label="Save file" disabled={!doc.dirty || doc.readOnly || doc.saving || !!doc.conflict || doc.missing} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent disabled:opacity-40" onClick={() => void store.save(doc.key)}><Save size={13} />Save</button>
      </>}
      {markdown && <button title="Open in MarkText" aria-label="Open in MarkText" className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent" onClick={() => void openMarkText()}><ExternalLink size={12} />MarkText</button>}
      {(kind === 'svg' || kind === 'html') && <button title="Open in browser" aria-label="Open in browser" className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent" onClick={() => void openBrowser()}><Globe size={12} />Browser</button>}
      {kind && (['editor', 'split', 'preview'] as const).map((mode) => <button key={mode} aria-label={`${kindLabel} ${mode}`} aria-pressed={doc.mode === mode} onClick={() => store.mode(doc.key, mode)} className={cn('rounded px-2 py-1 capitalize hover:bg-accent', doc.mode === mode && 'bg-accent')}>{mode}</button>)}
    </div>
    {findOpen && markdown && <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <input ref={findInput} aria-label="Find in Markdown preview" placeholder="Find in preview" value={findQuery} className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1" onChange={(e) => { setFindQuery(e.target.value); setFindIndex(0) }} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFindOpen(false); setFindQuery('') } if (e.key === 'Enter' && findCount) { e.preventDefault(); setFindIndex((i) => (i + (e.shiftKey ? findCount - 1 : 1)) % findCount) } }} />
      <span>{findCount ? findIndex + 1 : 0}/{findCount}</span>
      <button aria-label="Previous Markdown match" onClick={() => setFindIndex((i) => findCount ? (i + findCount - 1) % findCount : 0)}>↑</button>
      <button aria-label="Next Markdown match" onClick={() => setFindIndex((i) => findCount ? (i + 1) % findCount : 0)}>↓</button>
      <button aria-label="Close Markdown find" onClick={() => { setFindOpen(false); setFindQuery('') }}>×</button>
    </div>}
    {doc.conflict && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-destructive/10 p-2 text-xs">
      <span className="flex-1">This file changed on disk. Your unsaved buffer is preserved.</span>
      <button className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={() => void store.reload(doc.key)}>Reload disk</button>
      <button className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={() => store.keepBuffer(doc.key)}>Keep my buffer</button>
    </div>}
    {doc.missing && <p role="alert" className="shrink-0 border-b border-border p-2 text-xs text-destructive">The file was removed or is unavailable on disk. Your buffer is preserved.</p>}
    {doc.readOnly && <p role="status" className="shrink-0 border-b border-border p-2 text-xs text-muted-foreground">Read only: binary / non-UTF-8 content or file larger than 1 MB. Use an external editor for this file.</p>}
    <div className="min-h-0 flex-1">
      {doc.kind !== 'text' ? <MediaView doc={doc} leafId={leaf.id} /> : previewPane && doc.mode === 'preview' ? previewPane : previewPane && doc.mode === 'split' ? <Group orientation="horizontal" className="h-full"><Panel id="markdown-code" minSize="15%">{code}</Panel><Separator className="w-1 cursor-col-resize bg-border hover:bg-ring" /><Panel id="markdown-preview" minSize="15%">{previewPane}</Panel></Group> : code}
    </div>

    {doc.kind === 'text' && <div className="shrink-0 border-t border-border px-2 py-0.5 text-[10px] text-muted-foreground">{doc.eol === '\r\n' ? 'CRLF' : 'LF'} · UTF-8{doc.bom ? ' BOM' : ''} · {doc.saving ? 'Saving…' : doc.dirty ? 'Unsaved' : 'Saved'}</div>}
  </div>
}

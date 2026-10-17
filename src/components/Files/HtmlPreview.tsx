import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { FileDocument } from '@/lib/files/documents'
import { previewFrameUrl } from '@/lib/files/preview-kind'
import { previewBase, setPreviewDraft } from '@/tauri/files'

const DEBOUNCE_MS = 300

/**
 * The page loads from the media protocol at its own path, so relative CSS,
 * scripts and images resolve from its folder. An unsaved buffer is handed to
 * the backend as a draft and served in place of the disk copy.
 *
 * Not `srcdoc`: an about:srcdoc frame inherits the app CSP (`script-src
 * 'self'`) and would block every inline script. `allow-scripts` without
 * `allow-same-origin` gives the page an opaque origin — it can run its own JS
 * but cannot reach the app window or Tauri IPC.
 */
export function HtmlPreview({ doc }: { doc: FileDocument }): React.ReactElement {
  const [revision, setRevision] = useState(0)
  const [failed, setFailed] = useState<string | null>(null)
  // Last draft upload still in flight: the clear on unmount must run after it,
  // or a reordered upload could leave a stale draft registered.
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      pending.current = setPreviewDraft(doc.context.id, doc.path, doc.dirty ? doc.content : null)
        .then(() => { if (alive) { setFailed(null); setRevision((r) => r + 1) } }, (e) => { if (alive) setFailed(String(e)) })
    }, DEBOUNCE_MS)
    return () => { alive = false; clearTimeout(timer) }
  }, [doc.context.id, doc.path, doc.content, doc.dirty, doc.revision])
  // Drafts are memory-only; drop ours when the view goes away.
  useEffect(() => () => {
    void pending.current.then(() => setPreviewDraft(doc.context.id, doc.path, null)).catch(() => {})
  }, [doc.context.id, doc.path])
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1 text-[11px]">
      <span className="flex-1 text-muted-foreground">{doc.dirty ? 'Preview of unsaved changes' : 'Preview'} · scripts sandboxed</span>
      <button title="Reload preview" aria-label="Reload preview" className="rounded p-1 hover:bg-accent" onClick={() => setRevision((r) => r + 1)}><RotateCw size={12} /></button>
    </div>
    {failed ? <p role="alert" className="p-4 text-xs text-destructive">{failed}</p> :
      revision > 0 && <iframe key={revision} title="HTML preview" sandbox="allow-scripts" className="min-h-0 w-full flex-1 border-0 bg-white"
        src={previewFrameUrl(previewBase(doc.context.id), doc.path, revision)} />}
  </div>
}

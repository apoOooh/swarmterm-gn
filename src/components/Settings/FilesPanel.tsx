import { useEffect, useState, type ReactElement } from 'react'
import type { MarkdownMode } from '@/lib/markdown-pref'
import { cn } from '@/lib/utils'
import { useMarkdownPrefStore } from '@/store/markdown-pref-store'
import { locateMarkText } from '@/tauri/files'

const MODES: { id: MarkdownMode; label: string; description: string }[] = [
  { id: 'preview', label: 'Rendered', description: 'Formatted reading view' },
  { id: 'split', label: 'Split', description: 'Source and rendered side by side' },
  { id: 'editor', label: 'Source', description: 'Raw Markdown in the editor' }
]

/** Markdown viewing defaults and the external MarkText hand-off. */
export function FilesPanel(): ReactElement {
  const prefs = useMarkdownPrefStore((s) => s.prefs)
  const { setDefaultMode, setMarktextPath } = useMarkdownPrefStore.getState()
  const [draft, setDraft] = useState(prefs.marktextPath)
  // undefined = still probing; null = nothing found. Re-probed per saved path so
  // the status line always describes what "Open in MarkText" will actually launch.
  const [found, setFound] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    setFound(undefined)
    locateMarkText(prefs.marktextPath).then((p) => { if (live) setFound(p) }, () => { if (live) setFound(null) })
    return () => { live = false }
  }, [prefs.marktextPath])

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Files</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          How Markdown files open from the explorer. The view can be switched per file in its toolbar
          (Ctrl/Cmd+Shift+V cycles Source, Split and Rendered).
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-foreground">Open Markdown as</h2>
        <div role="radiogroup" aria-label="Default Markdown view" className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={prefs.defaultMode === m.id}
              onClick={() => setDefaultMode(m.id)}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                prefs.defaultMode === m.id ? 'border-primary bg-accent' : 'border-border hover:bg-accent/50'
              )}
            >
              <div className="text-sm font-medium text-foreground">{m.label}</div>
              <div className="text-xs text-muted-foreground">{m.description}</div>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold text-foreground">MarkText</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          "Open in MarkText" (file toolbar and explorer context menu) hands the file to the MarkText
          app. Leave the path empty to use the standard install location.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); setMarktextPath(draft) }}
        >
          <input
            aria-label="MarkText executable path"
            placeholder="Auto-detect (e.g. %LOCALAPPDATA%\Programs\marktext\marktext.exe)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setMarktextPath(draft)}
            className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 font-mono text-xs"
          />
          <button type="submit" className="rounded border border-border px-3 py-1 text-xs hover:bg-accent">Apply</button>
        </form>
        <p role="status" className={cn('mt-2 text-xs', found === null ? 'text-destructive' : 'text-muted-foreground')}>
          {found === undefined ? 'Looking for MarkText…'
            : found ? `Using ${found}`
            : prefs.marktextPath ? 'This path is not a MarkText executable.'
            : 'MarkText was not found. Install it from marktext.cc or enter its path.'}
        </p>
      </section>
    </div>
  )
}

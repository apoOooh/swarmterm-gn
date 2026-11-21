import { useEffect, useState, type ReactElement } from 'react'
import { cn } from '@/lib/utils'
import { CODEX_ITEM_LABELS, codexCustomItems, codexPreviewLine } from '@/lib/codex-statusline-preview'
import { SegmentList } from './SegmentList'
import type { Preset, Slot } from '@/lib/statusline-presets'
import {
  applyCodexStatusline,
  getCodexStatuslineStatus,
  releaseCodexStatusline,
  type CodexStatuslineStatus
} from '@/tauri/statusline'
import { useStatuslinePresetsStore } from '@/store/statusline-presets-store'

type CodexChoice = 'unmanaged' | 'off' | Preset

const OPTIONS: { id: CodexChoice; label: string; text: string }[] = [
  { id: 'unmanaged', label: 'Not managed', text: 'Swarmterm leaves Codex’s status line alone.' },
  { id: 'off', label: 'Off', text: 'Hides Codex’s status line.' },
  { id: 'compact', label: 'Compact', text: 'Model and context left.' },
  { id: 'extended', label: 'Extended', text: 'Adds git branch and the 5h / weekly limits.' },
  { id: 'detailed', label: 'Detailed', text: 'Adds token counts and the window size.' },
  { id: 'custom', label: 'Custom', text: 'Pick each item and its order.' }
]

const ITEM_NAMES = Object.fromEntries(Object.entries(CODEX_ITEM_LABELS).map(([id, label]) => [id, { label }]))

const STATE_TEXT: Record<CodexStatuslineStatus['state'], string> = {
  managed: 'managed by Swarmterm',
  custom: 'your own setting — left untouched',
  unmanaged: 'not managed',
  deferred: 'left to the installed Swarmterm (development build)'
}

/**
 * Codex status line (SWA-92). Codex draws it from built-in items, so the
 * preview is an example row and there are no schemes, vibrance or
 * animation — only Codex's own theme colours on or off. Every apply/release
 * also rewrites the Codex fields in `statusline.json` on the Rust side, so
 * the presets store is reloaded afterwards (a later Claude save would
 * otherwise write stale Codex values back).
 */
export function CodexStatuslinePicker({ brief = false }: { brief?: boolean }): ReactElement {
  const settings = useStatuslinePresetsStore((s) => s.settings)
  const loaded = useStatuslinePresetsStore((s) => s.loaded)
  const load = useStatuslinePresetsStore((s) => s.load)
  const [status, setStatus] = useState<CodexStatuslineStatus[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loaded) void load()
    getCodexStatuslineStatus().then(setStatus).catch(() => setStatus([]))
  }, [loaded, load])

  const choice: CodexChoice =
    settings.codex === null ? 'unmanaged' : settings.codexEnabled ? settings.codex : 'off'

  const run = async (fn: () => Promise<CodexStatuslineStatus[]>): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await fn())
    } catch (e) {
      console.warn('statusline: codex update failed', e)
    } finally {
      await load()
      setBusy(false)
    }
  }

  const choose = (c: CodexChoice): Promise<void> => {
    if (c === 'unmanaged') return run(releaseCodexStatusline)
    const preset: Preset = c === 'off' ? (settings.codex ?? 'compact') : c
    const items = preset === 'custom' ? codexCustomItems(settings.codexItems) : null
    return run(() => applyCodexStatusline(preset, settings.codexUseColors, c !== 'off', items))
  }

  const customItems = codexCustomItems(settings.codexItems)
  const setItems = (items: Slot[]): Promise<void> =>
    run(() => applyCodexStatusline('custom', settings.codexUseColors, true, items))

  const preview = choice !== 'unmanaged' && choice !== 'off' ? codexPreviewLine(choice, settings.codexItems) : null

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Codex status line" className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={choice === o.id}
            disabled={busy}
            onClick={() => void choose(o.id)}
            className={cn(
              'rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60',
              choice === o.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40'
            )}
          >
            <span className="block text-sm font-medium text-foreground">{o.label}</span>
            <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{o.text}</span>
          </button>
        ))}
      </div>

      {choice === 'custom' && (
        <SegmentList
          label="Codex status line items"
          slots={customItems}
          names={ITEM_NAMES}
          disabled={busy}
          onChange={(items) => void setItems(items)}
        />
      )}

      {preview !== null && (
        <div>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[12px]">{preview}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">Example — Codex draws this line itself, without animation.</p>
        </div>
      )}

      {!brief && choice !== 'unmanaged' && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={settings.codexUseColors}
            disabled={busy}
            onChange={(e) =>
              void run(() =>
                applyCodexStatusline(settings.codex ?? 'compact', e.target.checked, settings.codexEnabled)
              )
            }
          />
          Use Codex theme colours (Codex has its own themes; no vibrance)
        </label>
      )}

      {!brief && status.length > 0 && (
        <ul className="space-y-1 text-[11px] text-muted-foreground">
          {status.map((s) => (
            <li key={s.codexHome}>
              <span className="font-mono">{s.codexHome}</span>: {STATE_TEXT[s.state]}
              {s.version ? ` · Codex ${s.version}` : ''}
              {s.notice ? ` · ${s.notice}` : ''}
              {s.written ? ` · writes: ${s.written.length ? s.written.join(', ') : 'nothing (line hidden)'}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

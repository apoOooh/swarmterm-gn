import { useEffect, useState, type ReactElement } from 'react'
import { cn } from '@/lib/utils'
import { parseAnsi } from '@/lib/ansi-preview'
import {
  CHOICES,
  SCHEMES,
  choiceOf,
  vibranceApplies,
  type Choice,
  type StatuslineSettings
} from '@/lib/statusline-presets'
import { visualTheme } from '@/lib/theme-adapter'
import { previewStatusline } from '@/tauri/statusline-presets'
import { useAppearanceStore } from '@/store/appearance-store'
import { useStatuslinePresetsStore } from '@/store/statusline-presets-store'
import { useStatuslineStore } from '@/store/statusline-store'

/** Rows of the real renderer, drawn on the terminal background. */
export function StatuslinePreview({
  settings,
  columns
}: {
  settings: StatuslineSettings
  columns: number
}): ReactElement {
  const style = useAppearanceStore((s) => s.style)
  const [rows, setRows] = useState<string[]>([])
  useEffect(() => {
    let live = true
    previewStatusline(settings, columns)
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]))
    return () => {
      live = false
    }
  }, [settings, columns])
  const colors = visualTheme(style).colors
  return (
    <div
      className="overflow-x-auto rounded-md border border-border px-3 py-2 font-mono text-[12px] leading-[1.35]"
      style={{ background: colors.termBg, color: colors.text }}
      aria-label="Status line preview"
    >
      <div style={{ width: `${columns}ch` }}>
        {rows.map((row, i) => (
          <div key={i} className="whitespace-pre">
            {parseAnsi(row).map((s, j) => (
              <span key={j} style={s.color ? { color: s.color } : undefined}>
                {s.text}
              </span>
            ))}
            {row === '' ? ' ' : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Template cards with a live preview. `brief` (setup assistant) shows only
 * the templates; Settings → Status line adds width, scheme, vibrance and
 * animation.
 */
export function StatuslinePicker({ brief = false }: { brief?: boolean }): ReactElement {
  const { settings, loaded, load, update, choose } = useStatuslinePresetsStore()
  const enabled = useStatuslineStore((s) => s.enabled)
  const style = useAppearanceStore((s) => s.style)
  const [columns, setColumns] = useState(brief ? 100 : 120)
  const choice = choiceOf(enabled, settings)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // App theme takes its colours from the active Swarmterm theme; keep them
  // current so the line follows a theme switch.
  useEffect(() => {
    if (!loaded || settings.scheme !== 'app-theme') return
    const c = visualTheme(style).colors
    if (c.text !== settings.themeText || c.accent !== settings.themeAccent) {
      void update({ themeText: c.text, themeAccent: c.accent })
    }
  }, [loaded, settings.scheme, settings.themeText, settings.themeAccent, style, update])

  const card = (id: Choice, label: string, text: string): ReactElement => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={choice === id}
      onClick={() => void choose(id)}
      className={cn(
        'rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        choice === id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40'
      )}
    >
      <span className="block text-sm font-medium text-foreground">{label}</span>
      <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{text}</span>
    </button>
  )

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Status line template" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CHOICES.map((c) => card(c.id, c.label, c.text))}
      </div>

      {choice !== 'off' && <StatuslinePreview settings={settings} columns={columns} />}

      {!brief && choice !== 'off' && (
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-4">
            <span className="text-xs text-muted-foreground">Preview width: {columns} columns</span>
            <input
              type="range"
              min={40}
              max={200}
              step={5}
              value={columns}
              onChange={(e) => setColumns(Number(e.target.value))}
              className="w-48"
            />
          </label>

          <div>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">Colour scheme</h3>
            <div role="radiogroup" aria-label="Colour scheme" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {SCHEMES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={settings.scheme === s.id}
                  onClick={() => void update({ scheme: s.id })}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-left transition-colors',
                    settings.scheme === s.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40'
                  )}
                >
                  <span className="block text-sm text-foreground">{s.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{s.text}</span>
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center justify-between gap-4">
            <span className="text-xs text-muted-foreground">
              Vibrance: {settings.vibrance} %
              {!vibranceApplies(settings.scheme) && ' (App theme only)'}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={settings.vibrance}
              disabled={!vibranceApplies(settings.scheme)}
              onChange={(e) => void update({ vibrance: Number(e.target.value) })}
              className="w-48 disabled:opacity-40"
            />
          </label>
        </div>
      )}
    </div>
  )
}

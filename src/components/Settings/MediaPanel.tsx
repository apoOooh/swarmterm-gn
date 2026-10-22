import type { ReactElement } from 'react'
import { ToggleRow } from './NotificationsPanel'
import { OVERLAY_MAX_ITEMS_RANGE, OVERLAY_TIMEOUT_RANGE } from '@/lib/media-overlay'
import { useMediaPrefStore } from '@/store/media-pref-store'

interface NumberRowProps {
  label: string
  description: string
  value: number
  range: { min: number; max: number }
  disabled: boolean
  onChange: (n: number) => void
}

function NumberRow({ label, description, value, range, disabled, onChange }: NumberRowProps): ReactElement {
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <input
        type="number"
        min={range.min}
        max={range.max}
        value={value}
        disabled={disabled}
        // The store clamps; an empty field while typing is just ignored.
        onChange={(e) => { if (e.target.value !== '') onChange(Number(e.target.value)) }}
        className="w-20 rounded border border-border bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50"
      />
    </label>
  )
}

/** Settings → Media: the auto-show overlay and opt-in clipboard images. */
export function MediaSettingsPanel(): ReactElement {
  const prefs = useMediaPrefStore((s) => s.prefs)
  const update = useMediaPrefStore((s) => s.update)
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Media</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          Images and videos that agents show or print, and (opt-in) images you copy, are collected in the
          Media panel. A small popup can announce new items in the window corner; it never takes the keyboard
          from your terminal.
        </p>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold text-foreground">Popup for new media</h2>
        <ToggleRow label="Show popup" description="Corner list of the newest items; click one to open it in the Media panel." checked={prefs.overlay} onChange={(on) => update({ overlay: on })} />
        <NumberRow label="Hide after (seconds)" description="Pointing at the popup keeps it open." value={prefs.overlayTimeoutSec} range={OVERLAY_TIMEOUT_RANGE} disabled={!prefs.overlay} onChange={(n) => update({ overlayTimeoutSec: n })} />
        <NumberRow label="Items in the popup" description="Older items stay in the Media panel." value={prefs.overlayMaxItems} range={OVERLAY_MAX_ITEMS_RANGE} disabled={!prefs.overlay} onChange={(n) => update({ overlayMaxItems: n })} />
        <ToggleRow label="Agent output" description="Media paths printed in a pane (shown as names until you open them)." checked={prefs.overlayAgent} onChange={(on) => update({ overlayAgent: on })} />
        <ToggleRow label="Clipboard images" description="Needs Clipboard images below." checked={prefs.overlayClipboard} onChange={(on) => update({ overlayClipboard: on })} />
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold text-foreground">Clipboard</h2>
        <ToggleRow
          label="Clipboard images"
          description="Add images (and copied image/video files) you copy to the Media panel. Your clipboard can hold private content: images are saved only to a local temp folder, never sent anywhere, and deleted when Swarmterm exits."
          checked={prefs.clipboardImages}
          onChange={(on) => update({ clipboardImages: on })}
        />
      </section>
    </div>
  )
}

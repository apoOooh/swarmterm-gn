import type { ReactElement } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { moveSlot, toggleSlot, type Slot } from '@/lib/statusline-presets'

/**
 * Custom status line parts (SWA-93): a checkbox per part plus up/down
 * buttons for the order. Buttons rather than drag and drop so it works by
 * keyboard and does not compete with the dnd-kit layer around Settings.
 */
export function SegmentList<T extends string>({
  label,
  slots,
  names,
  disabled = false,
  onChange
}: {
  label: string
  slots: Slot<T>[]
  names: Record<string, { label: string; text?: string }>
  disabled?: boolean
  onChange: (next: Slot<T>[]) => void
}): ReactElement {
  return (
    <ol aria-label={label} className="divide-y divide-border rounded-md border border-border">
      {slots.map((s, i) => {
        const name = names[s.id] ?? { label: s.id }
        return (
          <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              <input type="checkbox" checked={s.on} disabled={disabled} onChange={() => onChange(toggleSlot(slots, i))} />
              <span className={s.on ? 'text-foreground' : 'text-muted-foreground'}>{name.label}</span>
              {name.text && <span className="truncate text-[11px] text-muted-foreground">{name.text}</span>}
            </label>
            <button
              type="button"
              aria-label={`Move ${name.label} up`}
              disabled={disabled || i === 0}
              onClick={() => onChange(moveSlot(slots, i, -1))}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted/50 disabled:opacity-30"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={`Move ${name.label} down`}
              disabled={disabled || i === slots.length - 1}
              onClick={() => onChange(moveSlot(slots, i, 1))}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted/50 disabled:opacity-30"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </li>
        )
      })}
    </ol>
  )
}

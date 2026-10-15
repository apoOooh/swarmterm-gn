import type { ReactElement } from 'react'
import { DndContext, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronUp, GripVertical, RotateCcw } from 'lucide-react'
import { GuardedPointerSensor } from '@/lib/dnd-sensors'
import { ALWAYS_CORE, HEADER_ITEMS, type HeaderItemId } from '@/lib/header-layout-pref'
import { useHeaderLayoutStore } from '@/store/header-layout-store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const LABELS = new Map<string, string>(HEADER_ITEMS.map(i => [i.id, i.label]))

/**
 * The "Title bar" settings category — reorder the pane header's items and pick
 * which are core (always in the row) versus allowed to collapse into the
 * second row that opens on hover.
 */
export function TitleBarPanel(): ReactElement {
  const order = useHeaderLayoutStore(s => s.order)
  const core = useHeaderLayoutStore(s => s.core)
  const move = useHeaderLayoutStore(s => s.move)
  const toggleCore = useHeaderLayoutStore(s => s.toggleCore)
  const reset = useHeaderLayoutStore(s => s.reset)
  const sensors = useSensors(useSensor(GuardedPointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (over && active.id !== over.id) move(active.id as HeaderItemId, over.id as HeaderItemId)
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Title bar</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          Arrange the controls in each pane's title bar. <span className="text-foreground">Core</span> items
          always stay in the bar; the others move to the second row (shown on hover or via ⋯) when a
          pane gets narrow — once you reorder, the lowest ones in the list go first. Maximize and close always stay at
          the right. Items only appear when they apply to the pane.
        </p>
      </section>

      <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Order and priority</h2>
          <Button variant="ghost" size="sm" onClick={reset} className="gap-1 text-muted-foreground">
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to defaults
          </Button>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <ul className="space-y-1" data-title-bar-items>
              {order.map((id, idx) => (
                <TitleBarRow
                  key={id}
                  id={id}
                  isCore={core.includes(id)}
                  onToggleCore={() => toggleCore(id)}
                  onUp={idx > 0 ? () => move(id, order[idx - 1]) : undefined}
                  onDown={idx < order.length - 1 ? () => move(id, order[idx + 1]) : undefined}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </section>
    </div>
  )
}

interface TitleBarRowProps {
  id: HeaderItemId
  isCore: boolean
  onToggleCore: () => void
  onUp?: () => void
  onDown?: () => void
}

function TitleBarRow({ id, isCore, onToggleCore, onUp, onDown }: TitleBarRowProps): ReactElement {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id })
  const label = LABELS.get(id) ?? id
  const locked = id === ALWAYS_CORE
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-item-id={id}
      className={cn(
        'flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-sm',
        isDragging && 'relative z-10 opacity-60 shadow-lg'
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        tabIndex={-1}
        aria-label={`Drag ${label}`}
        className="cursor-grab text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="flex-1 text-foreground">{label}</span>
      {/* aria-disabled, not disabled: an item moved to an end keeps focus on
          the arrow that took it there instead of dropping it to <body>. */}
      <Button variant="ghost" size="icon-sm" aria-disabled={!onUp} onClick={onUp} aria-label={`Move ${label} up`} className={cn(!onUp && 'opacity-40')}>
        <ChevronUp className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-disabled={!onDown} onClick={onDown} aria-label={`Move ${label} down`} className={cn(!onDown && 'opacity-40')}>
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      <button
        type="button"
        role="switch"
        aria-checked={isCore}
        aria-label={`${label}: ${isCore ? 'core' : 'can hide'}`}
        disabled={locked}
        title={locked ? 'The title is always core' : undefined}
        onClick={onToggleCore}
        className={cn(
          'w-20 rounded border px-2 py-0.5 text-xs',
          isCore ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
          locked && 'cursor-not-allowed opacity-60'
        )}
      >
        {isCore ? 'Core' : 'Can hide'}
      </button>
    </li>
  )
}

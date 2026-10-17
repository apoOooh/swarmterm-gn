import { createContext, useContext, useRef, type ReactElement, type ReactNode } from 'react'
import { GripHorizontal } from 'lucide-react'
import type { FloatRect } from '@/lib/floating-panes'
import { useAppStore } from '@/store/app-store'
import { cn } from '@/lib/utils'

/** Resize grips: which rect edges a drag moves (x/y = left/top edge, w/h = size). */
const GRIPS: { dir: string; className: string; x: 0 | 1; y: 0 | 1; w: -1 | 0 | 1; h: -1 | 0 | 1 }[] = [
  { dir: 'e', className: 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize', x: 0, y: 0, w: 1, h: 0 },
  { dir: 'w', className: 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize', x: 1, y: 0, w: -1, h: 0 },
  { dir: 's', className: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize', x: 0, y: 0, w: 0, h: 1 },
  { dir: 'se', className: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize', x: 0, y: 0, w: 1, h: 1 },
  { dir: 'sw', className: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize', x: 1, y: 0, w: -1, h: 1 }
]

/** Starts a free move of the enclosing floating window (pane header drag). */
const FloatMoveContext = createContext<((e: React.PointerEvent) => void) | null>(null)
export const useFloatMove = (): ((e: React.PointerEvent) => void) | null => useContext(FloatMoveContext)

/**
 * A floating window for one pane. The grip bar and the pane's own header move
 * it freely (the header drops its dnd-kit drag while floating, so no DockPicker
 * shows); docking goes through the header's Dock button. Geometry is
 * in workspace fractions — the store clamps every write.
 */
export function FloatingPane({ rect, label, children }: { rect: FloatRect; label: string; children: ReactNode }): ReactElement {
  const frameRef = useRef<HTMLDivElement>(null)
  const setFloatRect = useAppStore((s) => s.setFloatRect)

  function drag(e: React.PointerEvent, apply: (dx: number, dy: number) => FloatRect): void {
    if (e.button !== 0) return
    const area = frameRef.current?.parentElement
    if (!area) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const { width, height } = area.getBoundingClientRect()
    const sx = e.clientX
    const sy = e.clientY
    const move = (ev: PointerEvent): void => setFloatRect(apply((ev.clientX - sx) / width, (ev.clientY - sy) / height))
    const end = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    // Raise on grab: setFloatRect re-appends the rect, last = on top.
    setFloatRect(rect)
  }

  const move = (e: React.PointerEvent): void => drag(e, (dx, dy) => ({ ...rect, x: rect.x + dx, y: rect.y + dy }))

  return (
    <div
      ref={frameRef}
      data-floating-leaf={rect.leafId}
      className="absolute z-30 flex flex-col overflow-hidden rounded-md border border-border bg-canvas shadow-2xl"
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`
      }}
      onPointerDownCapture={() => useAppStore.getState().setFocusedLeaf(rect.leafId)}
    >
      <div
        title={`Move ${label}`}
        aria-label="Move floating pane"
        className="flex h-3.5 shrink-0 cursor-move items-center justify-center bg-card text-muted-foreground hover:bg-ring/40"
        onPointerDown={move}
      >
        <GripHorizontal className="h-3 w-3" />
      </div>
      <div className="min-h-0 flex-1"><FloatMoveContext.Provider value={move}>{children}</FloatMoveContext.Provider></div>
      {GRIPS.map((g) => (
        <div
          key={g.dir}
          className={cn('absolute z-10', g.className)}
          onPointerDown={(e) => drag(e, (dx, dy) => ({
            leafId: rect.leafId,
            x: rect.x + g.x * dx,
            y: rect.y + g.y * dy,
            w: rect.w + g.w * dx,
            h: rect.h + g.h * dy
          }))}
        />
      ))}
    </div>
  )
}

import { dragCursor, pastThreshold, type DragEffect } from '@/lib/pointer-drag'
import { useExplorerDragStore } from '@/store/explorer-drag-store'
import { useAppStore } from '@/store/app-store'
import { devLog } from '@/lib/dev-log'

/** What lies under the pointer, as the caller's hit-test sees it. */
export interface DragHit {
  effect: DragEffect
  /** Terminal pane to ring while hovering (reuses the OS-drop highlight). */
  terminalId?: string
  /** Explorer folder row to mark while hovering. */
  overDir?: string
}

export interface PointerDragOptions {
  /** Names shown in the ghost (paths or file names). */
  items: string[]
  hit: (x: number, y: number, copyKey: boolean) => DragHit
  drop: (x: number, y: number, copyKey: boolean, hit: DragHit) => void
  /** Called once the press crosses the drag threshold (e.g. to swallow the follow-up click). */
  onStart?: () => void
  /** Released before the drag threshold: it was a click, not a drag. */
  onTap?: (up: PointerEvent) => void
  /** Called when the gesture ends, dropped or not. */
  onEnd?: () => void
  /** dev-log event prefix */
  name: string
}

/**
 * One pointer-driven drag (see lib/pointer-drag.ts for why not HTML5): window
 * listeners from pointerdown to pointerup, the shared ghost in
 * explorer-drag-store, the root cursor and the target highlight. Esc cancels.
 */
export function startPointerDrag(down: { button: number; clientX: number; clientY: number }, opts: PointerDragOptions): void {
  if (down.button !== 0) return
  const start = { x: down.clientX, y: down.clientY }
  let active = false
  const reset = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('keydown', key, true)
    useExplorerDragStore.setState({ drag: null })
    useAppStore.getState().setDropTarget(null)
    delete document.documentElement.dataset.dragging
    document.documentElement.style.cursor = ''
    opts.onEnd?.()
  }
  const move = (ev: PointerEvent): void => {
    if (!active) {
      if (!pastThreshold(start, { x: ev.clientX, y: ev.clientY })) return
      active = true
      opts.onStart?.()
      devLog(`${opts.name}.drag-start`, { items: opts.items })
    }
    const copyKey = ev.ctrlKey || ev.metaKey
    const hit = opts.hit(ev.clientX, ev.clientY, copyKey)
    useAppStore.getState().setDropTarget(hit.terminalId ?? null)
    useExplorerDragStore.setState({ drag: { paths: opts.items, x: ev.clientX, y: ev.clientY, effect: hit.effect, overDir: hit.overDir ?? null } })
    document.documentElement.dataset.dragging = '1'
    document.documentElement.style.cursor = dragCursor(hit.effect)
  }
  const up = (ev: PointerEvent): void => {
    const was = active
    reset()
    if (!was) { opts.onTap?.(ev); return }
    const copyKey = ev.ctrlKey || ev.metaKey
    const hit = opts.hit(ev.clientX, ev.clientY, copyKey)
    devLog(`${opts.name}.drag-drop`, { items: opts.items, hit })
    if (hit.effect !== 'none') opts.drop(ev.clientX, ev.clientY, copyKey, hit)
  }
  const key = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    active = false
    reset()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('keydown', key, true)
}

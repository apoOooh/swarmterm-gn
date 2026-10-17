import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { PEEK_CLOSE_DELAY_MS, PEEK_OPEN_DELAY_MS, peekCloseDecision } from '@/lib/sidebar-peek'
import { OVERLAY_SELECTOR } from '@/lib/terminal-focus'

export interface EdgePeek {
  /** The panel is slid in (or sliding in). */
  peeking: boolean
  /** Peeking, or still sliding out — keep the panel absolute while true. */
  overlay: boolean
  /** Render the invisible edge strip while true. */
  showHotZone: boolean
  /** Spread onto the edge strip. */
  hotZoneProps: {
    onPointerEnter: (e: PointerEvent) => void
    onPointerLeave: () => void
  }
  /** Spread onto the peeking panel (undefined handlers while not peeking). */
  panelProps: {
    onPointerEnter?: () => void
    onPointerLeave?: (e: PointerEvent) => void
  }
  /** Slide out right away (e.g. the panel's close button). */
  close: () => void
}

/**
 * Edge-hover peek for a hidden side panel: resting the pointer on the edge
 * slides the panel in OVER the content (absolute, so nothing re-lays out);
 * leaving it slides it back out. Shared by the left sidebar and the right panel.
 */
export function useEdgePeek(canPeek: boolean, panelRef: RefObject<HTMLElement | null>): EdgePeek {
  const [peek, setPeek] = useState(false)
  const [closing, setClosing] = useState(false)
  const timer = useRef<number | null>(null)
  const peeking = canPeek && peek

  function clearTimer(): void {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }

  function schedule(open: boolean): void {
    clearTimer()
    timer.current = window.setTimeout(() => {
      timer.current = null
      if (open) {
        setClosing(false)
        setPeek(true)
        return
      }
      // Stay out while the pointer is back over the panel, or a menu / dialog
      // opened from it is up (Radix portals those outside the panel).
      const decision = peekCloseDecision({
        hovered: panelRef.current?.matches(':hover') ?? false,
        overlayOpen: document.querySelector(OVERLAY_SELECTOR) !== null,
        focusInside: panelRef.current?.contains(document.activeElement) ?? false
      })
      if (decision === 'defer') {
        schedule(false)
        return
      }
      setPeek(false)
    }, open ? PEEK_OPEN_DELAY_MS : PEEK_CLOSE_DELAY_MS)
  }

  useEffect(() => {
    if (canPeek) return
    clearTimer()
    setPeek(false)
  }, [canPeek])

  useEffect(() => () => clearTimer(), [])

  // Slide-out: stay absolute until the width transition has finished. Only on
  // a real open → closed edge, not on mount.
  const wasPeek = useRef(peek)
  useEffect(() => {
    const was = wasPeek.current
    wasPeek.current = peek
    if (peek || !was) return
    setClosing(true)
    const t = window.setTimeout(() => setClosing(false), 220)
    return () => window.clearTimeout(t)
  }, [peek])

  // Alt-tab away while peeking never sends pointerleave.
  useEffect(() => {
    if (!peeking) return
    const onBlur = (): void => { clearTimer(); setPeek(false) }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [peeking])

  return {
    peeking,
    overlay: canPeek && (peeking || closing),
    showHotZone: canPeek && !peek,
    hotZoneProps: {
      onPointerEnter: (e) => { if (e.buttons === 0) schedule(true) },
      onPointerLeave: clearTimer
    },
    panelProps: peeking
      ? {
          onPointerEnter: clearTimer,
          onPointerLeave: (e) => {
            // A drag leaving the panel must not close it under the drag;
            // decide once the button is released.
            if (e.buttons === 0) schedule(false)
            else window.addEventListener('pointerup', () => schedule(false), { once: true })
          }
        }
      : {},
    close: () => { clearTimer(); setPeek(false) }
  }
}

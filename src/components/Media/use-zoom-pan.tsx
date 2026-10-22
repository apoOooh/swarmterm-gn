/**
 * Wheel zoom + drag pan for an image in the Media viewer / annotate view.
 * Math is in lib/media-zoom.ts. Rules that are easy to break:
 * - The wheel is claimed (non-passive, preventDefault) only while the pointer
 *   is over the image itself; anywhere else scrolling behaves normally.
 * - Only a CSS transform changes (written straight to the elements, one rAF
 *   per frame): no React render per wheel event, no re-decode. getBoundingClientRect
 *   of the image therefore includes the zoom, so annotate's toImage mapping
 *   stays correct and marks stay in image pixels.
 * - Nothing takes the keyboard: mousedown is swallowed for pans, the controls
 *   are tabIndex -1, and Space (annotate pan) is claimed only while the pointer
 *   is over the viewer, like annotate's Esc.
 */
import { useCallback, useEffect, useRef, type ReactElement, type RefObject } from 'react'
import {
  FIT_VIEW, clampPan, fitRatio, oneToOne, panBy, scaleBounds, viewTransform, wheelFactor, zoomAt, type View,
} from '@/lib/media-zoom'

export interface ZoomPan {
  view: RefObject<View>
  fit: () => void
  actual: () => void
  label: RefObject<HTMLSpanElement | null>
}

interface Options {
  container: RefObject<HTMLElement | null>
  img: RefObject<HTMLImageElement | null>
  /** Elements sharing the image's box and transform (the annotate canvas). */
  extra?: RefObject<HTMLElement | null>
  enabled: boolean
  /** 'view': left-drag pans. 'annotate': middle-drag or Space+drag pans (left draws). */
  mode: 'view' | 'annotate'
  /** Changing it resets to Fit (another file). */
  resetKey: string
  onChange?: (v: View) => void
}

export function useZoomPan({ container, img, extra, enabled, mode, resetKey, onChange }: Options): ZoomPan {
  const view = useRef<View>(FIT_VIEW)
  /** The view last written to the DOM: getBoundingClientRect reflects this one. */
  const applied = useRef<View>(FIT_VIEW)
  const frame = useRef(0)
  const label = useRef<HTMLSpanElement | null>(null)
  /** Fit ratio from the last layout read; the label uses it without forcing layout. */
  const ratio = useRef(0)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const metrics = useCallback(() => {
    const el = img.current
    const box = container.current
    if (!el || !box || !el.naturalWidth || !el.clientWidth) return null
    const layout = { width: el.clientWidth, height: el.clientHeight }
    const ratio_ = fitRatio(layout, { width: el.naturalWidth, height: el.naturalHeight })
    ratio.current = ratio_
    const r = el.getBoundingClientRect()
    const a = applied.current
    return {
      rect: r, layout, ratio: ratio_,
      bounds: scaleBounds(ratio_),
      container: { width: box.clientWidth, height: box.clientHeight },
      // Layout centre = transformed centre minus the applied translation (scale is about the centre).
      centre: { x: r.left + r.width / 2 - a.tx, y: r.top + r.height / 2 - a.ty },
    }
  }, [img, container])

  const schedule = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const v = view.current
      applied.current = v
      const t = v === FIT_VIEW || (v.s === 1 && v.tx === 0 && v.ty === 0) ? '' : viewTransform(v)
      for (const el of [img.current, extra?.current]) if (el) el.style.transform = t
      if (label.current) label.current.textContent = ratio.current > 0 ? `${Math.round(v.s * ratio.current * 100)}%` : ''
      if (img.current && mode === 'view') img.current.style.cursor = v.s > 1 ? 'grab' : ''
      onChangeRef.current?.(v)
    })
  }, [img, extra, mode])

  const set = useCallback((v: View) => { view.current = v; schedule() }, [schedule])
  const fit = useCallback(() => set(FIT_VIEW), [set])
  const actual = useCallback(() => {
    const m = metrics()
    if (m) set(clampPan(zoomAt(view.current, { x: 0, y: 0 }, oneToOne(m.ratio), m.bounds), m.layout, m.container))
  }, [metrics, set])

  useEffect(() => { view.current = FIT_VIEW; schedule() }, [resetKey, schedule])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  useEffect(() => {
    const box = container.current
    if (!box || !enabled) return
    const over = (x: number, y: number): boolean => {
      const r = img.current?.getBoundingClientRect()
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    }
    /** Last pointer position: Space is claimed only while it is over the image. */
    let pointer: { x: number; y: number } | null = null
    let space = false
    let drag: { id: number; x: number; y: number } | null = null

    const onWheel = (e: WheelEvent): void => {
      if (!over(e.clientX, e.clientY)) {
        // A pinch next to the image must not page-zoom the webview instead.
        if (e.ctrlKey) e.preventDefault()
        return
      }
      const m = metrics()
      if (!m) return
      e.preventDefault()
      const f = wheelFactor(e, box.clientHeight || 600)
      const p = { x: e.clientX - m.centre.x, y: e.clientY - m.centre.y }
      set(clampPan(zoomAt(view.current, p, view.current.s * f, m.bounds), m.layout, m.container))
    }
    const wantsPan = (e: PointerEvent | MouseEvent): boolean => {
      if (!over(e.clientX, e.clientY)) return false
      if (mode === 'annotate') return e.button === 1 || (e.button === 0 && space)
      return e.button === 0 && view.current.s > 1
    }
    const onMouseDown = (e: MouseEvent): void => {
      // Middle button would start Chromium's autoscroll; a pan press must not move focus.
      if (wantsPan(e) || (e.button === 1 && over(e.clientX, e.clientY))) e.preventDefault()
    }
    const onDown = (e: PointerEvent): void => {
      if (!wantsPan(e)) return
      // Capture phase on the container: runs before the annotate canvas starts a mark.
      e.preventDefault()
      e.stopPropagation()
      box.setPointerCapture(e.pointerId)
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
      box.style.cursor = 'grabbing'
    }
    const onMove = (e: PointerEvent): void => {
      pointer = { x: e.clientX, y: e.clientY }
      if (!drag || e.pointerId !== drag.id) return
      e.stopPropagation()
      const m = metrics()
      const v = panBy(view.current, e.clientX - drag.x, e.clientY - drag.y)
      drag = { id: drag.id, x: e.clientX, y: e.clientY }
      set(m ? clampPan(v, m.layout, m.container) : v)
    }
    const onUp = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return
      e.stopPropagation()
      drag = null
      box.style.cursor = space ? 'grab' : ''
      if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId)
    }
    const onDbl = (e: MouseEvent): void => {
      if (mode === 'view' && over(e.clientX, e.clientY)) fit()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (mode !== 'annotate' || e.key !== ' ' || (!space && !(pointer && over(pointer.x, pointer.y)))) return
      // Capture phase on window: before xterm's textarea, so no space reaches the pane.
      e.preventDefault()
      e.stopPropagation()
      space = e.type === 'keydown'
      if (!drag) box.style.cursor = space ? 'grab' : ''
    }
    const loaded = (): void => { const m = metrics(); if (m) set(clampPan(view.current, m.layout, m.container)) }
    const leave = (): void => { pointer = null; space = false; if (!drag) box.style.cursor = '' }
    const ro = new ResizeObserver(loaded)
    const el = img.current
    if (el) { ro.observe(el); el.addEventListener('load', loaded); if (el.complete) loaded() }
    ro.observe(box)
    box.addEventListener('wheel', onWheel, { passive: false })
    box.addEventListener('mousedown', onMouseDown, true)
    box.addEventListener('pointerdown', onDown, true)
    box.addEventListener('pointermove', onMove, true)
    box.addEventListener('pointerup', onUp, true)
    box.addEventListener('pointercancel', onUp, true)
    box.addEventListener('dblclick', onDbl)
    box.addEventListener('mouseleave', leave)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      ro.disconnect()
      box.removeEventListener('wheel', onWheel)
      box.removeEventListener('mousedown', onMouseDown, true)
      box.removeEventListener('pointerdown', onDown, true)
      box.removeEventListener('pointermove', onMove, true)
      box.removeEventListener('pointerup', onUp, true)
      box.removeEventListener('pointercancel', onUp, true)
      box.removeEventListener('dblclick', onDbl)
      el?.removeEventListener('load', loaded)
      box.removeEventListener('mouseleave', leave)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      box.style.cursor = ''
    }
    // resetKey: the <img> element is replaced per file (key={url}).
  }, [container, img, enabled, mode, metrics, set, fit, resetKey])

  return { view, fit, actual, label }
}

const swallow = (e: { preventDefault: () => void }): void => e.preventDefault()

/** Small corner control: zoom percent, Fit and 1:1. Never takes focus. */
export function ZoomControls({ zoom }: { zoom: ZoomPan }): ReactElement {
  const cls = 'rounded px-1 hover:bg-muted hover:text-foreground'
  return <div data-focus-return className="absolute bottom-1 right-1 z-10 flex items-center gap-1 rounded border border-border bg-background/80 px-1 text-[10px] text-muted-foreground">
    <span ref={zoom.label} className="min-w-8 text-right tabular-nums" />
    <button tabIndex={-1} onMouseDown={swallow} onClick={zoom.fit} title="Fit to panel (double-click the image)" className={cls}>Fit</button>
    <button tabIndex={-1} onMouseDown={swallow} onClick={zoom.actual} title="Actual size (1:1)" className={cls}>1:1</button>
  </div>
}

/** A plain viewer image with wheel zoom, drag pan and the corner control. */
export function ZoomableImage({ src, alt, className, onError }: { src: string; alt: string; className: string; onError: () => void }): ReactElement {
  const container = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const zoom = useZoomPan({ container, img, enabled: true, mode: 'view', resetKey: src })
  // overflow-hidden: a transformed child would otherwise grow the scroll area.
  return <div ref={container} className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden ${className}`}>
    <img key={src} ref={img} src={src} alt={alt} className="max-h-full max-w-full select-none object-contain" draggable={false} onError={onError} />
    <ZoomControls zoom={zoom} />
  </div>
}

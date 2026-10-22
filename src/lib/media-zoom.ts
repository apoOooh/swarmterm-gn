/**
 * Zoom and pan in the Media viewer (and annotate view). Pure math only; the
 * DOM side is components/Media/use-zoom-pan.tsx.
 *
 * The view is a CSS transform `translate(tx, ty) scale(s)` around the image's
 * untransformed (fit-to-panel) layout centre. `s` is relative to that fit
 * size, so s = 1 is "Fit" and s = 1 / fitRatio is "1:1" (natural pixels).
 * Points passed here are screen pixels relative to the layout centre.
 */
import type { Point, Size, ViewBox } from '@/lib/media-annotate'

export interface View { s: number; tx: number; ty: number }

export const FIT_VIEW: View = { s: 1, tx: 0, ty: 0 }
/** Zoom limits as a share of the natural size: 10% .. 2000%. */
export const MIN_NATURAL_ZOOM = 0.1
export const MAX_NATURAL_ZOOM = 20

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Fit size / natural size (shown pixels per image pixel at s = 1). */
export function fitRatio(layout: Size, natural: Size): number {
  return layout.width > 0 && natural.width > 0 ? layout.width / natural.width : 1
}

/** Allowed `s` range; Fit (1) is always reachable even for tiny or huge images. */
export function scaleBounds(ratio: number): { min: number; max: number } {
  if (!(ratio > 0)) return { min: 1, max: 1 }
  return { min: Math.min(1, MIN_NATURAL_ZOOM / ratio), max: Math.max(1, MAX_NATURAL_ZOOM / ratio) }
}

/** `s` that shows the image at its natural size. */
export const oneToOne = (ratio: number): number => (ratio > 0 ? 1 / ratio : 1)

/** Line and page wheel deltas -> pixels, limited so one notch never jumps far. */
export function wheelPixels(e: { deltaY: number; deltaMode: number }, pageHeight: number): number {
  const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * pageHeight : e.deltaY
  return clamp(px, -400, 400)
}

/**
 * Multiplicative zoom factor for one wheel event. A trackpad pinch arrives as
 * a wheel event with ctrlKey and small deltas, so it gets a stronger gain.
 * One mouse notch (100 px) is ~x1.22.
 */
export function wheelFactor(e: { deltaY: number; deltaMode: number; ctrlKey: boolean }, pageHeight: number): number {
  return Math.exp(-wheelPixels(e, pageHeight) * (e.ctrlKey ? 0.01 : 0.002))
}

/** How far the image may move from centre: only by its overhang beyond the container. */
export function clampPan(v: View, layout: Size, container: Size): View {
  const ox = Math.max(0, (v.s * layout.width - container.width) / 2)
  const oy = Math.max(0, (v.s * layout.height - container.height) / 2)
  // `|| 0` folds -0 into 0.
  return { s: v.s, tx: clamp(v.tx, -ox, ox) || 0, ty: clamp(v.ty, -oy, oy) || 0 }
}

/** Zoom to `s` (clamped) keeping the image point under `p` fixed on screen. */
export function zoomAt(v: View, p: Point, s: number, bounds: { min: number; max: number }): View {
  const next = clamp(s, bounds.min, bounds.max)
  const k = next / v.s
  return { s: next, tx: p.x - (p.x - v.tx) * k, ty: p.y - (p.y - v.ty) * k }
}

/** Screen-space translation by a drag delta. */
export const panBy = (v: View, dx: number, dy: number): View => ({ s: v.s, tx: v.tx + dx, ty: v.ty + dy })

/** The on-screen image box under the view, from its untransformed layout box. */
export function transformedBox(layout: ViewBox, v: View): ViewBox {
  const cx = layout.left + layout.width / 2 + v.tx
  const cy = layout.top + layout.height / 2 + v.ty
  const w = layout.width * v.s
  const h = layout.height * v.s
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h }
}

export const viewTransform = (v: View): string => `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`

export const sameView = (a: View, b: View): boolean => a.s === b.s && a.tx === b.tx && a.ty === b.ty

/** Most backing pixels an annotate canvas may use while zoomed. */
export const MAX_CANVAS_PIXELS = 16_000_000

/**
 * Backing-store multiplier for the annotate canvas: follow the zoom so marks
 * stay sharp, but never below 1 or past MAX_CANVAS_PIXELS.
 */
export function canvasQuality(s: number, layout: Size, dpr: number): number {
  const base = layout.width * layout.height * dpr * dpr
  if (!(base > 0)) return 1
  return Math.max(1, Math.min(s, Math.sqrt(MAX_CANVAS_PIXELS / base)))
}

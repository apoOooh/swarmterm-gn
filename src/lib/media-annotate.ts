/**
 * Annotating an image in the Media viewer: the mark model, coordinate mapping,
 * undo, rendering and the flatten size. Marks live in IMAGE pixels (the file's
 * natural resolution), so they stay put when the viewer resizes, and the
 * flattened PNG is drawn with the same code at scale 1 (or the downscale).
 */

export type AnnotateTool = 'pen' | 'marker' | 'line' | 'arrow' | 'rect' | 'ellipse'

export interface Point { x: number; y: number }

export interface Mark {
  tool: AnnotateTool
  color: string
  /** Line width in image pixels. */
  width: number
  /** Freehand: every kept point. Shapes: exactly [start, end] of the drag. */
  points: Point[]
  /** Rect/ellipse only: filled (semi-transparent) instead of an outline. */
  fill?: boolean
}

export const ANNOTATE_COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#ffffff', '#000000'] as const
/** The marker is a highlighter: wider and see-through. */
export const MARKER_ALPHA = 0.4
export const MARKER_WIDTH_FACTOR = 3
export const FILL_ALPHA = 0.3
/** Longest flattened side; bigger images are scaled down to it. */
export const FLATTEN_MAX_SIDE = 8192

export const isFreehand = (tool: AnnotateTool): boolean => tool === 'pen' || tool === 'marker'

/** The rendered image box (getBoundingClientRect of the <img>) and the image's natural size. */
export interface ViewBox { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }

/** Viewport point -> image pixel, clamped to the image. */
export function toImage(p: Point, box: ViewBox, natural: Size): Point {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 }
  const x = ((p.x - box.left) / box.width) * natural.width
  const y = ((p.y - box.top) / box.height) * natural.height
  return { x: clamp(x, 0, natural.width), y: clamp(y, 0, natural.height) }
}

/** Image pixels per screen pixel (> 1 when the viewer shows the image smaller). */
export function imagePerScreen(box: ViewBox, natural: Size): number {
  return box.width > 0 ? natural.width / box.width : 1
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Appends a freehand point unless it is closer than `minDist` (image px) to
 * the last kept one: pointer events arrive at device rate and with jitter, so
 * thinning them plus the midpoint curves in `drawMark` gives a smooth line
 * whatever the pressure or event rate.
 */
export function addPoint(points: Point[], p: Point, minDist: number): Point[] {
  const last = points[points.length - 1]
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDist) return points
  return [...points, p]
}

/** A drag in any direction -> a box with non-negative size. */
export function normRect(a: Point, b: Point): { x: number; y: number; width: number; height: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

/** The two back corners of an arrowhead at `head`, sized from the line width. */
export function arrowHead(tail: Point, head: Point, width: number): [Point, Point] {
  const len = Math.max(10, width * 4)
  const angle = Math.atan2(head.y - tail.y, head.x - tail.x)
  const spread = Math.PI / 7
  const corner = (a: number): Point => ({ x: head.x - len * Math.cos(a), y: head.y - len * Math.sin(a) })
  return [corner(angle - spread), corner(angle + spread)]
}

/** A shape too small to see (a click without a drag) is not kept. */
export function isVisibleMark(m: Mark): boolean {
  if (m.points.length === 0) return false
  if (isFreehand(m.tool)) return true
  const [a, b] = m.points
  return !!b && Math.hypot(b.x - a.x, b.y - a.y) >= 2
}

/** Marks plus an undo history (each entry is the mark list before a change). */
export interface MarkState { marks: Mark[]; past: Mark[][] }

export const emptyMarks = (): MarkState => ({ marks: [], past: [] })

export function addMark(s: MarkState, m: Mark): MarkState {
  if (!isVisibleMark(m)) return s
  return { marks: [...s.marks, m], past: [...s.past, s.marks] }
}

/** Clear is undoable too, so a mis-click does not lose the work. */
export function clearMarks(s: MarkState): MarkState {
  if (s.marks.length === 0) return s
  return { marks: [], past: [...s.past, s.marks] }
}

export function undoMark(s: MarkState): MarkState {
  if (s.past.length === 0) return s
  return { marks: s.past[s.past.length - 1], past: s.past.slice(0, -1) }
}

/** Output size for the flattened PNG: natural size, scaled down to `maxSide`. */
export function flattenSize(natural: Size, maxSide = FLATTEN_MAX_SIDE): Size & { scale: number } {
  const w = Math.max(1, Math.round(natural.width))
  const h = Math.max(1, Math.round(natural.height))
  const scale = Math.min(1, maxSide / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale }
}

/** Gallery name of a marked copy: `shot.png` -> `shot (marked).png`. */
export function markedName(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? 'image'
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${stem} (marked).png`
}

/** The canvas calls drawMark uses (a structural subset, so tests can record). */
export interface Ctx2D {
  globalAlpha: number
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  closePath(): void
  rect(x: number, y: number, w: number, h: number): void
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void
  arc(x: number, y: number, r: number, start: number, end: number): void
  stroke(): void
  fill(): void
}

/** Draws one mark in image coordinates (the caller sets the transform). */
export function drawMark(ctx: Ctx2D, m: Mark): void {
  if (m.points.length === 0) return
  const marker = m.tool === 'marker'
  const width = marker ? m.width * MARKER_WIDTH_FACTOR : m.width
  ctx.save()
  ctx.strokeStyle = m.color
  ctx.fillStyle = m.color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.globalAlpha = marker ? MARKER_ALPHA : 1
  ctx.beginPath()
  const [a, b = a] = m.points
  switch (m.tool) {
    case 'pen':
    case 'marker': {
      const pts = m.points
      if (pts.length === 1) {
        // A dot: a click without movement still leaves a mark.
        ctx.arc(a.x, a.y, width / 2, 0, Math.PI * 2)
        ctx.fill()
        break
      }
      ctx.moveTo(a.x, a.y)
      // Midpoint quadratic curves smooth the polyline through the kept points.
      for (let i = 1; i < pts.length - 1; i++) {
        const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mid.x, mid.y)
      }
      const last = pts[pts.length - 1]
      ctx.lineTo(last.x, last.y)
      ctx.stroke()
      break
    }
    case 'line':
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      break
    case 'arrow': {
      const [l, r] = arrowHead(a, b, width)
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(l.x, l.y)
      ctx.lineTo(r.x, r.y)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      break
    }
    case 'rect':
    case 'ellipse': {
      const box = normRect(a, b)
      if (m.tool === 'rect') ctx.rect(box.x, box.y, box.width, box.height)
      else ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2)
      if (m.fill) {
        ctx.globalAlpha = FILL_ALPHA
        ctx.fill()
        ctx.globalAlpha = 1
      }
      ctx.stroke()
      break
    }
  }
  ctx.restore()
}

/**
 * Largest image (in pixels) the annotate view decodes. A small, highly
 * compressed PNG can declare 40000x40000: decoding that needs GBs and freezes
 * the renderer, so such files are refused before any decode.
 */
export const ANNOTATE_MAX_PIXELS = 100_000_000

/**
 * Pixel size declared in an image header (PNG, JPEG, GIF, WebP, BMP), read
 * without decoding. `null` when the format is unknown or the header is cut;
 * such files are let through, so the cap is best-effort (common formats only).
 * EXIF orientation is ignored: harmless, the pixel product is the same.
 */
export function imageHeaderSize(bytes: Uint8Array): Size | null {
  const b = bytes
  const n = b.length
  const u16be = (i: number): number => (b[i] << 8) | b[i + 1]
  const u16le = (i: number): number => b[i] | (b[i + 1] << 8)
  const u24le = (i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  const u32be = (i: number): number => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])
  const i32le = (i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)
  const ascii = (i: number, s: string): boolean => i + s.length <= n && [...s].every((c, k) => b[i + k] === c.charCodeAt(0))
  // PNG: signature, then IHDR width/height (big-endian u32).
  if (n >= 24 && b[0] === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR')) return { width: u32be(16), height: u32be(20) }
  if (n >= 10 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return { width: u16le(6), height: u16le(8) }
  if (n >= 26 && ascii(0, 'BM')) return { width: Math.abs(i32le(18)), height: Math.abs(i32le(22)) }
  if (n >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8X')) return { width: u24le(24) + 1, height: u24le(27) + 1 }
    if (ascii(12, 'VP8L') && b[20] === 0x2f) {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (ascii(12, 'VP8 ')) return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    return null
  }
  // JPEG: walk the segments to the first SOFn frame header.
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 8 < n) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      if (marker === 0xff) { i++; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) return { width: u16be(i + 7), height: u16be(i + 5) }
      i += 2 + u16be(i + 2)
    }
  }
  return null
}

/** Why the annotate view refuses `size`, or `null` when it may be decoded. */
export function annotateSizeError(size: Size | null): string | null {
  if (!size || size.width * size.height <= ANNOTATE_MAX_PIXELS) return null
  return `This image is too large to annotate (${size.width} x ${size.height} px; the limit is ${ANNOTATE_MAX_PIXELS / 1_000_000} megapixels).`
}

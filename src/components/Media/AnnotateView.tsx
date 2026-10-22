/**
 * Media viewer annotate mode: draw on an opened image, then save a marked copy
 * (new temp file, new gallery item) or drag it straight into a pane. The
 * original file is never written. Rules that are easy to break:
 * - Marks are stored in IMAGE pixels (lib/media-annotate.ts) and re-rendered
 *   on every resize, so they stay on the spot they mark.
 * - It never takes the keyboard: controls are tabIndex -1 with mousedown
 *   swallowed, and drawing swallows mousedown too. Esc is claimed only while
 *   the pointer is over the viewer (agents use Esc to interrupt).
 * - Nothing here is reachable by agents: the save/read commands are main
 *   webview only and have no MCP counterpart.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { Circle, GripVertical, Highlighter, Minus, MoveUpRight, Pencil, Save, Square, Trash2, Undo2, X } from 'lucide-react'
import {
  ANNOTATE_COLORS, addMark, addPoint, clearMarks, drawMark, emptyMarks, imagePerScreen, isFreehand, markedName, toImage, undoMark,
  type AnnotateTool, type Mark, type MarkState, type Size,
} from '@/lib/media-annotate'
import { mediaDropPane, mediaDropText } from '@/lib/media-drag'
import type { MediaItem } from '@/lib/media-gallery'
import { startPointerDrag } from '@/lib/pointer-drag-session'
import { insertIntoPane } from '@/components/FileDropListener'
import { flattenMarked } from '@/components/Media/flatten-marked'
import { useMediaStore } from '@/store/media-store'
import { readOpenedImage, saveMarkedImage } from '@/tauri/files'
import { focusTerminal } from '@/lib/terminal-registry'
import { selectFocusedTerminalId, useAppStore } from '@/store/app-store'

/** `source` of marked copies in the gallery. */
export const MARKED_SOURCE = 'marked'

const TOOLS: { tool: AnnotateTool; title: string; Icon: typeof Pencil }[] = [
  { tool: 'pen', title: 'Pen', Icon: Pencil },
  { tool: 'marker', title: 'Marker (wide, see-through)', Icon: Highlighter },
  { tool: 'line', title: 'Line', Icon: Minus },
  { tool: 'arrow', title: 'Arrow (drag from tail to head)', Icon: MoveUpRight },
  { tool: 'rect', title: 'Rectangle', Icon: Square },
  { tool: 'ellipse', title: 'Ellipse', Icon: Circle },
]

const swallow = (e: { preventDefault: () => void }): void => e.preventDefault()

/**
 * The width slider and Fill checkbox are real inputs, which take DOM focus on
 * click, and focus-return stands down for inputs. Hand the keyboard back to
 * the terminal as soon as the user lets go, so typing never moves the slider.
 */
function returnFocus(el: HTMLElement): void {
  el.blur()
  const id = selectFocusedTerminalId(useAppStore.getState())
  if (id) focusTerminal(id)
}
const btn = 'rounded p-1 hover:bg-muted disabled:opacity-40'

export function AnnotateView({ item, onClose }: { item: MediaItem; onClose: () => void }): ReactElement {
  const [tool, setTool] = useState<AnnotateTool>('pen')
  const [color, setColor] = useState<string>(ANNOTATE_COLORS[0])
  /** Screen pixels; converted to image pixels when a mark starts. */
  const [width, setWidth] = useState(4)
  const [fill, setFill] = useState(false)
  const [state, setState] = useState<MarkState>(emptyMarks)
  const [draft, setDraftState] = useState<Mark | null>(null)
  // Mirror for pointerup: continuous pointermove updates may not have
  // re-rendered yet, so the handler's closure could hold an older draft.
  const draftRef = useRef<Mark | null>(null)
  const setDraft = (d: Mark | null): void => {
    draftRef.current = d
    setDraftState(d)
  }
  const [natural, setNatural] = useState<Size | null>(null)
  /** The bytes shown AND flattened: frozen for the session, so an agent re-writing the file cannot shift what the marks cover. */
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hovered = useRef(false)
  /** The last saved copy, reused while the marks are unchanged (drag twice = one file). */
  const saved = useRef<{ marks: Mark[]; path: Promise<string> } | null>(null)
  const label = markedName(item.path)

  const redraw = useCallback(() => {
    const img = imgRef.current
    const canvas = canvasRef.current
    if (!img || !canvas || !natural) return
    const w = img.clientWidth
    const h = img.clientHeight
    Object.assign(canvas.style, { left: `${img.offsetLeft}px`, top: `${img.offsetTop}px`, width: `${w}px`, height: `${h}px` })
    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, Math.round(w * dpr))
    const ch = Math.max(1, Math.round(h * dpr))
    // Assigning width/height reallocates the backing store: only on resize,
    // not on every pointermove while drawing.
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    ctx.setTransform((dpr * w) / natural.width, 0, 0, (dpr * h) / natural.height, 0, 0)
    for (const m of state.marks) drawMark(ctx, m)
    if (draft) drawMark(ctx, draft)
  }, [natural, state, draft])

  useEffect(() => {
    let url: string | null = null
    let live = true
    readOpenedImage(item.path).then((bytes) => {
      if (!live) return
      const blob = new Blob([bytes])
      url = URL.createObjectURL(blob)
      setImage({ blob, url })
    }, (err) => { if (live) setError(`Could not load the image: ${String(err)}`) })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [item.path])

  useLayoutEffect(redraw, [redraw])
  // One observer per loaded image; it calls the latest redraw through a ref
  // instead of being rebuilt on every pointermove.
  const redrawRef = useRef(redraw)
  redrawRef.current = redraw
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const ro = new ResizeObserver(() => redrawRef.current())
    ro.observe(img)
    return () => ro.disconnect()
  }, [image])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !hovered.current) return
      // Capture phase on window: runs before xterm's textarea sees the key.
      e.preventDefault()
      e.stopPropagation()
      if (draftRef.current) setDraft(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const pointAt = (e: { clientX: number; clientY: number }): { p: { x: number; y: number }; ips: number } | null => {
    const img = imgRef.current
    if (!img || !natural) return null
    const box = img.getBoundingClientRect()
    return { p: toImage({ x: e.clientX, y: e.clientY }, box, natural), ips: imagePerScreen(box, natural) }
  }

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0 || busy) return
    const at = pointAt(e)
    if (!at) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraft({
      tool,
      color,
      width: width * at.ips,
      points: isFreehand(tool) ? [at.p] : [at.p, at.p],
      ...(tool === 'rect' || tool === 'ellipse' ? { fill } : {}),
    })
  }
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const d = draftRef.current
    if (!d) return
    const at = pointAt(e)
    if (!at) return
    if (isFreehand(d.tool)) {
      // Thin freehand points to ~1.5 screen px (smoothing in drawMark).
      const points = addPoint(d.points, at.p, 1.5 * at.ips)
      if (points !== d.points) setDraft({ ...d, points })
    } else {
      setDraft({ ...d, points: [d.points[0], at.p] })
    }
  }
  const onUp = (): void => {
    const d = draftRef.current
    if (!d) return
    setState((s) => addMark(s, d))
    setDraft(null)
  }

  /** Flatten + store the current marks once; later calls reuse the same file. */
  const ensureSaved = (): Promise<string> => {
    const marks = state.marks
    if (saved.current && saved.current.marks === marks) return saved.current.path
    if (!natural || !image) return Promise.reject(new Error('image not loaded'))
    const path = flattenMarked(image.blob, natural, marks).then(saveMarkedImage)
    saved.current = { marks, path }
    // A failed save must not be reused by the next attempt.
    path.catch(() => { if (saved.current?.path === path) saved.current = null })
    return path
  }
  const marked = (path: string): MediaItem => ({ path, kind: 'image', terminalId: '', source: MARKED_SOURCE, shownAt: Date.now(), opened: true, label })

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const path = await ensureSaved()
      useMediaStore.getState().show(marked(path))
      onClose()
    } catch (err) {
      setError(`Could not save the marked copy: ${String(err)}`)
      setBusy(false)
    }
  }

  // Drag the marked result into a pane. Flattening starts with the drag, so
  // the file is usually written by the time the pointer reaches a pane.
  const onDragHandle = (e: ReactPointerEvent): void => {
    if (busy || state.marks.length === 0) return
    const paneAt = (x: number, y: number) => mediaDropPane(document.elementFromPoint(x, y) as HTMLElement | null)
    startPointerDrag(e, {
      name: 'media-marked',
      items: [label],
      ghost: image ? { url: image.url } : { icon: 'image' },
      onStart: () => { void ensureSaved().catch(() => undefined) },
      hit: (x, y) => {
        const pane = paneAt(x, y)
        return pane ? { effect: 'copy', terminalId: pane.terminalId } : { effect: 'none' }
      },
      drop: (x, y) => {
        const pane = paneAt(x, y)
        if (!pane) return
        ensureSaved().then((path) => {
          // Joins the strip (without leaving annotate mode) so the user sees what the agent got.
          useMediaStore.getState().add(marked(path))
          const text = mediaDropText(path, pane)
          if (text !== '') insertIntoPane(pane.terminalId, text)
        }, (err) => setError(`Could not save the marked copy: ${String(err)}`))
      },
    })
  }

  const shape = tool === 'rect' || tool === 'ellipse'
  return <div
    className="flex min-h-0 flex-1 flex-col"
    onMouseEnter={() => { hovered.current = true }}
    onMouseLeave={() => { hovered.current = false }}
  >
    <div data-focus-return className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1 text-xs">
      {TOOLS.map(({ tool: t, title, Icon }) => (
        <button key={t} tabIndex={-1} onMouseDown={swallow} onClick={() => setTool(t)} title={title} aria-pressed={tool === t}
          className={[btn, tool === t ? 'bg-muted text-foreground' : 'text-muted-foreground'].join(' ')}>
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-border" />
      {ANNOTATE_COLORS.map((c) => (
        <button key={c} tabIndex={-1} onMouseDown={swallow} onClick={() => setColor(c)} title={c} aria-pressed={color === c}
          className={['h-4 w-4 rounded-full border', color === c ? 'border-foreground ring-1 ring-foreground' : 'border-border'].join(' ')}
          style={{ background: c }} />
      ))}
      <input type="range" min={1} max={30} value={width} tabIndex={-1} title={`Width ${width}px`} aria-label="Width"
        onChange={(e) => setWidth(Number(e.target.value))} onPointerUp={(e) => returnFocus(e.currentTarget)} className="w-20" />
      {shape && <label className="flex items-center gap-1 text-muted-foreground" title="Fill rectangles and ellipses">
        <input type="checkbox" tabIndex={-1} checked={fill} onChange={(e) => { setFill(e.target.checked); returnFocus(e.currentTarget) }} />Fill
      </label>}
      <span className="mx-1 h-4 w-px bg-border" />
      <button tabIndex={-1} onMouseDown={swallow} onClick={() => setState(undoMark)} disabled={state.past.length === 0} title="Undo" className={btn}><Undo2 className="h-3.5 w-3.5" /></button>
      <button tabIndex={-1} onMouseDown={swallow} onClick={() => setState(clearMarks)} disabled={state.marks.length === 0} title="Clear (undo brings it back)" className={btn}><Trash2 className="h-3.5 w-3.5" /></button>
      <span className="flex-1" />
      <button tabIndex={-1} onMouseDown={swallow} onPointerDown={onDragHandle} disabled={busy || state.marks.length === 0}
        title="Drag into a pane to insert the marked copy" className={[btn, 'cursor-grab'].join(' ')}><GripVertical className="h-3.5 w-3.5" /></button>
      <button tabIndex={-1} onMouseDown={swallow} onClick={() => void save()} disabled={busy || state.marks.length === 0}
        title="Save a marked copy to the gallery (the original stays unchanged)" className={[btn, 'flex items-center gap-1 text-foreground'].join(' ')}>
        <Save className="h-3.5 w-3.5" />Save copy
      </button>
      <button tabIndex={-1} onMouseDown={swallow} onClick={onClose} title="Cancel (Esc while over the image)" className={btn}><X className="h-3.5 w-3.5" /></button>
    </div>
    {error && <p role="alert" className="shrink-0 px-2 py-1 text-xs text-destructive">{error}</p>}
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
      {image && <img ref={imgRef} src={image.url} alt={item.path} draggable={false}
        onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        className="max-h-full max-w-full select-none object-contain" />}
      <canvas ref={canvasRef} className="absolute cursor-crosshair touch-none"
        onMouseDown={swallow} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDraft(null)} />
    </div>
  </div>
}

import { useEffect, useRef, useState } from 'react'
import { fitView, zoomAt, type View } from '@/lib/files/preview-kind'
import { cn } from '@/lib/utils'

const BACKGROUNDS = ['dark', 'light', 'checker'] as const
type Background = typeof BACKGROUNDS[number]

/**
 * Renders the live buffer, not the file on disk, so every keystroke shows.
 * Loaded as an <img> on purpose: the image context never runs an SVG's
 * scripts or event handlers, so no sanitizer is needed.
 */
export function SvgPreview({ content }: { content: string }): React.ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const fitted = useRef(false)
  const [url, setUrl] = useState<string>()
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [background, setBackground] = useState<Background>('dark')
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [content])
  function fit(w = size?.w ?? 0, h = size?.h ?? 0): void {
    const rect = box.current?.getBoundingClientRect()
    if (rect) setView(fitView(w, h, rect.width, rect.height))
  }
  function actual(): void {
    const rect = box.current?.getBoundingClientRect()
    if (rect && size) setView({ scale: 1, x: (rect.width - size.w) / 2, y: (rect.height - size.h) / 2 })
  }
  // React's onWheel is passive, so preventDefault (no page scroll) needs a native listener.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1 text-[11px]">
      <span className="flex-1 text-muted-foreground">{size ? `${Math.round(size.w)} × ${Math.round(size.h)}` : ''}{size ? ` · ${Math.round(view.scale * 100)} %` : ''}</span>
      <button className="rounded px-2 py-1 hover:bg-accent" onClick={() => fit()}>Fit</button>
      <button className="rounded px-2 py-1 hover:bg-accent" onClick={actual}>100 %</button>
      {BACKGROUNDS.map((b) => <button key={b} aria-label={`SVG background ${b}`} aria-pressed={background === b} onClick={() => setBackground(b)} className={cn('rounded px-2 py-1 capitalize hover:bg-accent', background === b && 'bg-accent')}>{b}</button>)}
    </div>
    <div ref={box} aria-label="SVG preview" className={cn('svg-preview relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing', `svg-preview-${background}`)}
      onDoubleClick={() => fit()}
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => {
        const from = drag.current
        if (!from) return
        drag.current = { x: e.clientX, y: e.clientY }
        setView((v) => ({ ...v, x: v.x + e.clientX - from.x, y: v.y + e.clientY - from.y }))
      }}
      onPointerUp={() => { drag.current = null }}>
      {broken ? <p role="alert" className="p-4 text-xs text-destructive">The SVG cannot be rendered — check the markup in the editor.</p> : url &&
        <img src={url} alt="" draggable={false} className="absolute left-0 top-0 max-w-none origin-top-left select-none"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onError={() => setBroken(true)}
          onLoad={(e) => {
            setBroken(false)
            // SVGs without width/height report 0 (or 150) — fall back to a usable box.
            const w = e.currentTarget.naturalWidth || 300, h = e.currentTarget.naturalHeight || 150
            setSize({ w, h })
            // Fit once per open; later edits keep the user's zoom and position.
            if (!fitted.current) { fitted.current = true; fit(w, h) }
          }} />}
    </div>
  </div>
}

import { useEffect, useRef, useState } from 'react'
import { mediaVersion, reloadStep, resumeAt, type MediaStat, type ReloadState } from '@/lib/files/media'
import { mediaUrl, openMediaExternal, revealFile, statMedia } from '@/tauri/files'
import { useDocumentStore } from '@/store/document-store'
import type { FileDocument } from '@/lib/files/documents'
import { useAppStore } from '@/store/app-store'
import { collectLeaves } from '@/lib/layout-tree'
const positions = new Map<string, number>()

export function MediaView({ doc, leafId }: { doc: FileDocument; leafId: string }): React.ReactElement {
  const active = useAppStore((s) => !s.welcomeFocused && s.workspaces.some((w) => w.id === s.activeWorkspaceId && collectLeaves(w.layout).some((l) => l.id === leafId)))
  const activeRef = useRef(active); activeRef.current = active
  const alive = useRef(true)
  const [stat, setStat] = useState<MediaStat | null | undefined>()
  const [broken, setBroken] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const reload = useRef<ReloadState>({ loaded: undefined, pending: undefined, lastSeq: 0 })
  const sequence = useRef(0)
  const resume = useRef<{ time: number; playing: boolean } | null>({ time: positions.get(doc.key) ?? 0, playing: false })
  const check = useRef<() => void>(() => {})
  check.current = () => {
    const seq = ++sequence.current
    const apply = (next: MediaStat | null): void => {
      if (!alive.current || !activeRef.current) return
      const result = reloadStep(reload.current, seq, next); reload.current = result.state
      if (result.action === 'none') return
      if (video.current) resume.current = { time: video.current.currentTime, playing: !video.current.paused }
      setBroken(false); setStat(next)
    }
    void statMedia(doc.context.id, doc.path).then(apply, () => apply(null))
  }
  useEffect(() => { if (active) check.current() }, [doc.path, doc.revision, active])
  useEffect(() => {
    if (!active) { video.current?.pause(); return }
    const timer = setInterval(() => { if (document.visibilityState === 'visible') check.current() }, 3000)
    const focus = (): void => check.current()
    window.addEventListener('focus', focus)
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); video.current?.pause() }
  }, [active])
  useEffect(() => { alive.current = true; return () => { alive.current = false; video.current?.pause() } }, [])
  const url = stat ? mediaUrl(doc.context.id, doc.path, mediaVersion(stat)) : undefined
  function fail(e: unknown): void { useDocumentStore.setState({ error: String(e) }) }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 justify-end gap-2 border-b border-border px-2 py-1 text-xs">
      <button className="rounded px-2 py-1 hover:bg-accent" onClick={() => void openMediaExternal(doc.context.id, doc.path).catch(fail)}>Open in default app</button>
      <button className="rounded px-2 py-1 hover:bg-accent" onClick={() => void revealFile(doc.context.id, doc.path).catch(fail)}>Reveal file</button>
    </div>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      {stat === null || broken ? <p role="alert" className="text-xs text-destructive">This media could not be loaded. Check the file, project scope, and platform codec support.</p> : !url ? <p className="text-xs text-muted-foreground">Loading media…</p> : doc.kind === 'video' ?
        <video key={url} ref={video} controls preload="metadata" src={url} className="max-h-full max-w-full" onTimeUpdate={(e) => { positions.set(doc.key, e.currentTarget.currentTime); if (positions.size > 128) positions.delete(positions.keys().next().value!) }} onLoadedMetadata={(e) => {
          const old = resume.current; resume.current = null
          if (old) { e.currentTarget.currentTime = resumeAt(old.time, e.currentTarget.duration); if (old.playing && activeRef.current) void e.currentTarget.play().catch(() => {}) }
        }} onError={() => setBroken(true)} /> :
        <img key={url} src={url} alt={doc.path} className="max-h-full max-w-full object-contain" draggable={false} onError={() => setBroken(true)} />}
    </div>
  </div>
}

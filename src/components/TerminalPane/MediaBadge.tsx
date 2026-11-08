/**
 * "N new images" pill on a pane whose output mentioned media files the user
 * has not opened yet (passive detection, lib/media-passive.ts). The panel is
 * never opened for passive items on its own; this click is the only way.
 * It sits inside the pane (not over the native preview column), so it needs
 * no overlay-watch registration, and mousedown is swallowed so the terminal
 * keeps keyboard focus.
 */
import type { ReactElement } from 'react'
import { Images } from 'lucide-react'
import { useMediaStore } from '@/store/media-store'
import { useGitStore } from '@/store/git-store'

export function MediaBadge({ terminalId }: { terminalId: string }): ReactElement | null {
  const count = useMediaStore((s) => s.unseen[terminalId] ?? 0)
  if (count === 0) return null
  const label = count === 1 ? '1 new image/video' : `${count} new images/videos`
  return (
    <button
      data-no-dnd
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const media = useMediaStore.getState()
        const newest = media.items.find((i) => i.terminalId === terminalId)
        media.clearUnseen(terminalId)
        useGitStore.getState().setMode('media')
        // The click is the user action that registers the file for serving.
        if (newest) void media.open(newest.path)
      }}
      title="Open in the Media panel"
      className="absolute right-3 top-2 z-10 flex items-center gap-1.5 rounded-full border border-[#a855f7]/50 bg-card/95 px-2.5 py-1 text-[11px] text-muted-foreground shadow-lg transition-colors hover:text-foreground"
    >
      <Images className="h-3 w-3 shrink-0 text-[#a855f7]" />
      {label}
    </button>
  )
}

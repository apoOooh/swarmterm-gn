// src/components/RightPanel/RightPanel.tsx
import { useRef, type ReactElement } from 'react'
import { useSidebarPeekStore } from '@/store/sidebar-peek-store'
import { useEdgePeek } from '@/components/use-edge-peek'
import { Eye, GitBranch, Pin, RotateCw, Swords, X } from 'lucide-react'
import { useGitStore } from '@/store/git-store'
import { BrowserColumn } from '@/components/Browser/BrowserColumn'
import { GitPanel } from '@/components/Git/GitPanel'
import { WarRoomPanel } from '@/components/WarRoom/WarRoomPanel'

function RefreshButton(): ReactElement {
  const refresh = useGitStore((s) => s.refresh)
  return (
    <button
      onClick={refresh}
      className="ml-auto flex items-center px-2 text-muted-foreground hover:text-foreground"
      aria-label="Refresh"
      title="Refresh git"
    >
      <RotateCw className="h-3.5 w-3.5" />
    </button>
  )
}

interface RightPanelProps {
  /** Rendered as the edge-hover overlay instead of the docked split. */
  peek?: boolean
  /** Peek only: slide the overlay out. */
  onClosePeek?: () => void
}

export function RightPanel({ peek = false, onClosePeek }: RightPanelProps = {}): ReactElement {
  const mode = useGitStore((s) => s.mode)
  const setPanelOpen = useGitStore((s) => s.setPanelOpen)

  function handleClose(): void {
    if (peek) onClosePeek?.()
    else setPanelOpen(false)
  }

  // setMode also opens (docks) the panel — while peeking, switch tabs only.
  function switchTo(next: 'browser' | 'git' | 'warroom'): void {
    if (peek) useGitStore.setState({ mode: next })
    else useGitStore.getState().setMode(next)
  }

  function handleBrowserTab(): void {
    switchTo('browser')
  }

  function handleGitTab(): void {
    switchTo('git')
  }

  function handleWarRoomTab(): void {
    switchTo('warroom')
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-l border-border bg-background">
      {/* Mode tab strip */}
      <div className="flex shrink-0 items-stretch border-b border-border bg-muted/30">
        <button
          onClick={handleBrowserTab}
          className={[
            'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
            mode === 'browser'
              ? 'border-b-2 border-[#0ea5e9] bg-background text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          ].join(' ')}
        >
          <Eye className="h-3.5 w-3.5" />
          Preview
        </button>
        <button
          onClick={handleGitTab}
          className={[
            'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
            mode === 'git'
              ? 'border-b-2 border-[#4ec994] bg-background text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          ].join(' ')}
        >
          <GitBranch className="h-3.5 w-3.5" />
          Git
        </button>
        <button
          onClick={handleWarRoomTab}
          className={[
            'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
            mode === 'warroom'
              ? 'border-b-2 border-[#f97316] bg-background text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          ].join(' ')}
        >
          <Swords className="h-3.5 w-3.5" />
          War Room
        </button>
        {mode === 'git' && <RefreshButton />}
        {peek && (
          <button
            onClick={() => setPanelOpen(true)}
            className={['flex items-center px-2 text-muted-foreground hover:text-foreground', mode === 'git' ? '' : 'ml-auto'].join(' ')}
            aria-label="Pin panel"
            title="Pin panel"
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={handleClose}
          className="flex items-center px-2 text-muted-foreground hover:text-foreground"
          aria-label="Close panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Mode content */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {mode === 'browser' && !peek && <BrowserColumn />}
        {mode === 'browser' && peek && (
          // The native preview webview paints above all page content, so it
          // cannot live inside a floating overlay — dock the panel to use it.
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
            <p>Pin the panel to use Preview.</p>
            <button
              onClick={() => setPanelOpen(true)}
              className="rounded border border-border px-2 py-1 text-foreground hover:bg-muted"
            >
              Pin panel
            </button>
          </div>
        )}
        {mode === 'git' && <GitPanel />}
        {mode === 'warroom' && <WarRoomPanel />}
      </div>
    </div>
  )
}

/**
 * Right-edge peek: with the right panel closed, resting the pointer on the
 * right edge slides it in OVER the workspace (absolute, so no terminal
 * re-lays out). Must render inside the app's DndContext so panes can still be
 * dropped on the War Room.
 */
export function RightPanelPeek(): ReactElement | null {
  const panelOpen = useGitStore((s) => s.panelOpen)
  const peekEnabled = useSidebarPeekStore((s) => s.rightEnabled)
  const ref = useRef<HTMLDivElement>(null)
  const edgePeek = useEdgePeek(!panelOpen && peekEnabled, ref)

  return (
    <>
      {edgePeek.showHotZone && (
        <div aria-hidden data-focus-return className="absolute inset-y-0 right-0 z-40 w-3" {...edgePeek.hotZoneProps} />
      )}
      {edgePeek.overlay && (
        <div
          ref={ref}
          {...edgePeek.panelProps}
          className="absolute inset-y-0 right-0 z-40 shadow-2xl transition-[width] duration-200 ease-in-out motion-reduce:transition-none overflow-hidden"
          style={{ width: edgePeek.peeking ? 'max(320px, 30vw)' : 0 }}
        >
          <span hidden data-covers-webview />
          <div className="h-full" style={{ width: 'max(320px, 30vw)' }}>
            <RightPanel peek onClosePeek={edgePeek.close} />
          </div>
        </div>
      )}
    </>
  )
}

import { useEffect, type ReactElement } from 'react'
import { ExplorerDragGhost } from '@/components/Files/ExplorerDragGhost'
import { onFileDrop, type DropPosition } from '@/tauri/dragdrop'
import { paneDropText, dropPointToCss } from '@/lib/terminal-drop'
import { devLog } from '@/lib/dev-log'
import { getTerminalCwd } from '@/lib/terminal-registry'
import { isMacPlatform, isWindowsPlatform } from '@/lib/platform'
import { focusTerminal, pasteIntoTerminal } from '@/lib/terminal-registry'
import { useAppStore } from '@/store/app-store'
import type { ShellFlavor } from '@/lib/agent-spawn-command'

/** The pane under a drop point, resolved from the DOM contract in TerminalPane. */
interface DropPane {
  terminalId: string
  leafId: string
  flavor: ShellFlavor
  agentId?: string
  cwd: string
}

function paneAt(position: DropPosition): DropPane | null {
  return paneAtCss(dropPointToCss(position, window.devicePixelRatio, isMacPlatform()))
}

function paneAtCss(point: { x: number; y: number }): DropPane | null {
  const el = document.elementFromPoint(point.x, point.y)
  const pane = el?.closest<HTMLElement>('[data-terminal-id]')
  const terminalId = pane?.dataset.terminalId
  const leafId = pane?.dataset.leafId
  const flavor = pane?.dataset.shellFlavor as ShellFlavor | undefined
  if (!terminalId || !leafId || !flavor) return null
  return { terminalId, leafId, flavor, agentId: pane?.dataset.agentId, cwd: getTerminalCwd(terminalId) ?? pane?.dataset.cwd ?? '' }
}

function typeInto(target: DropPane, text: string): void {
  // Paste rather than write: this routes through the registry's onData, so
  // when broadcast is armed the path lands in every selected pane, matching
  // what typing does.
  pasteIntoTerminal(target.terminalId, text)
  useAppStore.getState().setFocusedLeaf(target.leafId)
  focusTerminal(target.terminalId)
}

/** Types explorer-dragged paths into a pane (pointer drag, see lib/pointer-drag.ts). */
export function insertExplorerPaths(terminalId: string, paths: string[]): void {
  const target = paneById(terminalId)
  if (!target) return
  const text = paneDropText(paths, target, isWindowsPlatform())
  if (text !== '') typeInto(target, text)
}

/** Pastes ready-made text (a media drag, see lib/media-drag.ts) into a pane and focuses it. */
export function insertIntoPane(terminalId: string, text: string): void {
  const target = paneById(terminalId)
  if (target && text !== '') typeInto(target, text)
}

function paneById(terminalId: string): DropPane | null {
  const el = document.querySelector<HTMLElement>(`[data-terminal-id="${CSS.escape(terminalId)}"]`)
  const leafId = el?.dataset.leafId
  const flavor = el?.dataset.shellFlavor as ShellFlavor | undefined
  if (!el || !leafId || !flavor) return null
  return { terminalId, leafId, flavor, agentId: el.dataset.agentId, cwd: getTerminalCwd(terminalId) ?? el.dataset.cwd ?? '' }
}

/**
 * Types the paths of files dropped from the OS file manager into whichever pane
 * they were dropped on. Renders nothing; mounted once at app level because the
 * native drag event is per-window, not per-element.
 */
export function FileDropListener(): ReactElement {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    void onFileDrop((event) => {
      const { setDropTarget } = useAppStore.getState()

      if (event.type === 'leave') {
        setDropTarget(null)
        return
      }
      if (event.type === 'enter' || event.type === 'over') {
        setDropTarget(paneAt(event.position)?.terminalId ?? null)
        return
      }

      setDropTarget(null)
      const target = paneAt(event.position)
      devLog('native.drop', { paths: event.paths, position: event.position, target })
      // Dropped outside any pane (navbar, preview column, Welcome): do nothing
      // rather than guess at the focused pane and type into the wrong shell.
      if (!target) return

      // OS drops keep plain quoted paths for every pane, agents included.
      const text = paneDropText(event.paths, { ...target, agentId: undefined }, isWindowsPlatform())
      if (text === '') return

      typeInto(target, text)
    }).then((fn) => {
      // The effect may have been torn down before the listener resolved.
      if (cancelled) fn()
      else unlisten = fn
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  // The ghost of pointer drags (explorer rows, file tabs) lives here too: app-level, so it
  // still shows when the sidebar is hidden.
  return <ExplorerDragGhost />
}

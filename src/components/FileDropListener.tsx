import { useEffect, type ReactElement } from 'react'
import { onFileDrop, type DropPosition } from '@/tauri/dragdrop'
import { paneDropText, dropPointToCss } from '@/lib/terminal-drop'
import { takeExplorerDrag } from '@/lib/explorer-drag'
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

/**
 * Explorer drag released at a CSS point (its `dragend`). On Windows Tauri's
 * native drag-drop handler swallows in-window drags: neither the pane's HTML5
 * `drop` nor a native drop event arrives (dev log: dragend with dropEffect
 * "none" and nothing else). `dragend` still reports where the button went up,
 * so the pane is found from that point instead.
 */
export function dropExplorerDragAt(point: { x: number; y: number }): void {
  const paths = takeExplorerDrag()
  const target = paths ? paneAtCss(point) : null
  devLog('explorer.drop-at', { point, paths, target })
  if (!paths || !target) return
  const text = paneDropText(paths, target, isWindowsPlatform())
  if (text !== '') typeInto(target, text)
}

/**
 * Types the paths of files dropped from the OS file manager into whichever pane
 * they were dropped on. Renders nothing; mounted once at app level because the
 * native drag event is per-window, not per-element.
 */
export function FileDropListener(): ReactElement | null {
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

      // An in-window drag from Files reaches us with no paths (see explorer-drag.ts).
      const explorer = event.paths.length === 0 ? takeExplorerDrag() : null
      const text = explorer
        ? paneDropText(explorer, target, isWindowsPlatform())
        : paneDropText(event.paths, { ...target, agentId: undefined }, isWindowsPlatform())
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

  return null
}

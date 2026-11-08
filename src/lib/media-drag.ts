/**
 * Dragging a Media thumbnail (panel strip or overlay popup) into a pane. It is
 * the pointer-driven drag of lib/pointer-drag-session.ts (Tauri swallows
 * in-window HTML5 drags on Windows), and the result is what Ctrl+V of an
 * image gives: Claude Code / Codex get the path as a paste so the CLI attaches
 * the image, any other pane gets the quoted path like an Explorer file drop.
 *
 * Security rules this file keeps: a drag only TYPES a path the user can see
 * in the gallery. It never registers an unopened item for serving (only
 * `open`, on a plain click, does), and the path must still be in the media
 * store at drop time and pass `imagePasteText` (no newline or quote).
 */
import type { DragHit, PointerDragOptions } from '@/lib/pointer-drag-session'
import { imagePasteText, supportsImagePaste } from '@/lib/clipboard-image'
import { formatDroppedPaths } from '@/lib/terminal-drop'
import type { ShellFlavor } from '@/lib/agent-spawn-command'
import type { MediaItem } from '@/lib/media-gallery'

/** The pane a drop would land in, read from TerminalPane's data-* contract. */
export interface MediaDropPane {
  terminalId: string
  agentId?: string
  flavor: ShellFlavor
}

/** Minimal element surface (so the resolution is testable without a DOM). */
interface ElementLike {
  closest: (selector: string) => { dataset: Record<string, string | undefined> } | null
}

/**
 * The pane under the pointer, or null. The preview column is a native webview
 * painted over a placeholder div outside any `[data-terminal-id]`, and the
 * overlay popup sits outside panes too, so neither resolves to a target.
 */
export function mediaDropPane(el: ElementLike | null): MediaDropPane | null {
  const ds = el?.closest('[data-terminal-id]')?.dataset
  const terminalId = ds?.terminalId
  const flavor = ds?.shellFlavor as ShellFlavor | undefined
  if (!terminalId || !flavor) return null
  return { terminalId, flavor, agentId: ds?.agentId || undefined }
}

/** Text typed into `pane` for a dropped media path; `''` = type nothing. */
export function mediaDropText(path: string, pane: { agentId?: string; flavor: ShellFlavor }): string {
  // imagePasteText is the gate for every pane: a path it cannot carry
  // (newline, quote) is refused outright, not re-quoted for the shell.
  const ref = imagePasteText(path)
  if (ref === '') return ''
  return supportsImagePaste(pane.agentId) ? ref : formatDroppedPaths([path], pane.flavor)
}

/** Ghost content: the thumbnail only for an opened image (unopened items are never fetched). */
export function mediaGhost(item: Pick<MediaItem, 'opened' | 'kind'>): 'thumb' | 'film' | 'placeholder' {
  if (!item.opened) return 'placeholder'
  return item.kind === 'video' ? 'film' : 'thumb'
}

export interface MediaDragDeps {
  /** Element under a viewport point (document.elementFromPoint). */
  elementAt: (x: number, y: number) => ElementLike | null
  /** Whether `path` is (still) a media-store item; only those are draggable. */
  isKnown: (path: string) => boolean
  /** Paste `text` into the pane and give it the keyboard. */
  insert: (terminalId: string, text: string) => void
  /** Plain click: the item's normal open action. */
  onTap: () => void
}

/** Options for startPointerDrag for one thumbnail. */
export function mediaDragOptions(path: string, deps: MediaDragDeps): PointerDragOptions {
  const target = (x: number, y: number): MediaDropPane | null => (deps.isKnown(path) ? mediaDropPane(deps.elementAt(x, y)) : null)
  return {
    name: 'media',
    items: [path],
    hit: (x, y): DragHit => {
      const pane = target(x, y)
      return pane ? { effect: 'copy', terminalId: pane.terminalId } : { effect: 'none' }
    },
    drop: (x, y) => {
      // Re-resolve rather than trust the hit: the item may have left the store.
      const pane = target(x, y)
      if (!pane) return
      const text = mediaDropText(path, pane)
      if (text !== '') deps.insert(pane.terminalId, text)
    },
    onTap: () => deps.onTap(),
  }
}

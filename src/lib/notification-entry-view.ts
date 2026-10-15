import { collectLeaves, type LayoutNode } from '@/lib/layout-tree'
import type { CenterEntry } from '@/lib/notification-center'
import { templateById } from '@/lib/templates'

/** The slice of a workspace the bell needs to locate an entry's pane. */
export interface EntryWorkspace {
  name: string
  layout: LayoutNode
  drawerLeafIds?: string[]
}

/**
 * How the bell shows one entry. `reveal` means clicking jumps to the pane;
 * an enabled entry without `reveal` (backend alerts) is only marked read.
 */
export interface EntryView {
  subtitle: string
  disabled: boolean
  reveal: boolean
}

/**
 * Resolved at render, not at record time: the pane may have moved, been
 * renamed or closed since. A pane entry whose pane is gone renders disabled.
 * Backend entries (kind 'backend') belong to no pane: they show their detail
 * and stay clickable so they can be marked read.
 */
export function centerEntryView(workspaces: readonly EntryWorkspace[], entry: CenterEntry): EntryView {
  if (entry.kind === 'backend') {
    return { subtitle: entry.detail || 'Background service', disabled: false, reveal: false }
  }
  for (const ws of workspaces) {
    const leaf = collectLeaves(ws.layout).find((l) => l.terminalId === entry.terminalId)
    if (leaf === undefined) continue
    const paneLabel = entry.detail || templateById(leaf.agentId ?? 'terminal').name
    const drawered = ws.drawerLeafIds?.includes(leaf.id) === true
    return { subtitle: `${ws.name} · ${drawered ? `${paneLabel} (drawer)` : paneLabel}`, disabled: false, reveal: true }
  }
  return { subtitle: 'Pane closed', disabled: true, reveal: false }
}

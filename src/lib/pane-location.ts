/**
 * Where a terminal sits in the UI, as the user reads it off the pane header:
 * "Pane 2" in workspace "Backend" (SWA-90). War Room members are named by
 * title + folder at join time, and four "Claude Code · repo" members are
 * normal — the pane number is what tells them apart, so the room shows it
 * next to every member and message. Computed live from the layout: the
 * number shifts when panes are reordered or parked, a stored copy would lie.
 *
 * Numbering is the navbar's / pane header's (`visibleLeaves` order, BUZ-5):
 * drawered panes have no number.
 */
import { collectLeaves, type LayoutNode } from '@/lib/layout-tree'

export interface LocatableWorkspace {
  name: string
  layout: LayoutNode
  drawerLeafIds?: string[]
}

export interface PaneLocation {
  workspaceName: string
  /** 1-based pane number; 0 = parked in the drawer (no number). */
  number: number
}

export function paneLocations(workspaces: LocatableWorkspace[]): Map<string, PaneLocation> {
  const out = new Map<string, PaneLocation>()
  for (const w of workspaces) {
    const drawer = new Set(w.drawerLeafIds ?? [])
    let n = 0
    for (const leaf of collectLeaves(w.layout)) {
      const parked = drawer.has(leaf.id)
      if (!parked) n++
      out.set(leaf.terminalId, { workspaceName: w.name, number: parked ? 0 : n })
    }
  }
  return out
}

export function locatePane(workspaces: LocatableWorkspace[], terminalId: string): PaneLocation | null {
  return paneLocations(workspaces).get(terminalId) ?? null
}

/**
 * "Pane 2 · Backend", or "Drawer · Backend" for a parked pane. The workspace
 * is left out while only one is open — it would be the same on every row.
 */
export function paneLocationLabel(loc: PaneLocation, withWorkspace: boolean): string {
  const pane = loc.number > 0 ? `Pane ${loc.number}` : 'Drawer'
  return withWorkspace && loc.workspaceName ? `${pane} · ${loc.workspaceName}` : pane
}

/** Labels for every pane, keyed by terminalId (MCP `list_peers`). */
export function paneLocationLabels(workspaces: LocatableWorkspace[]): Record<string, string> {
  const withWorkspace = workspaces.length > 1
  const out: Record<string, string> = {}
  for (const [id, loc] of paneLocations(workspaces)) out[id] = paneLocationLabel(loc, withWorkspace)
  return out
}

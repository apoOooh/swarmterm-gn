/**
 * Which saved panes are still running in the terminal host (SWA-56).
 *
 * A pane survives an app crash in the host; the saved snapshot keeps its
 * id, so reopening the workspace can hand that id to `create_terminal`,
 * which then attaches instead of spawning. The host — not the snapshot,
 * which may lag behind by the sync debounce — knows the pane's agent and
 * folder, so those win.
 */
import type { ReattachLeaf, SavedLeaf, SavedNode, SavedWorkspace } from './saved-workspaces'
import type { DetachedPane } from '@/tauri/terminal-host'

function leaves(node: SavedNode): SavedLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(leaves)
}

/** Every pane id the saved workspaces reference: the panes that may still be opened. */
export function savedPaneIds(list: SavedWorkspace[]): string[] {
  return list.flatMap(w => leaves(w.layout)).flatMap(l => (l.terminalId ? [l.terminalId] : []))
}

/**
 * Resolver for `fromSaved`. Single use per id: a pane can only be shown
 * once, and an id an open workspace already holds is never taken again
 * (the same saved workspace opened twice).
 */
export function reattachResolver(
  detached: DetachedPane[],
  taken: Iterable<string>
): (leaf: SavedLeaf) => ReattachLeaf | undefined {
  const open = new Map(detached.map(p => [p.terminalId, p]))
  for (const id of taken) open.delete(id)
  return (leaf) => {
    const pane = leaf.terminalId ? open.get(leaf.terminalId) : undefined
    if (!pane) return undefined
    open.delete(pane.terminalId)
    return { terminalId: pane.terminalId, agentId: pane.meta?.agentId ?? 'terminal', cwd: pane.cwd }
  }
}

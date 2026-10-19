import { attentionCount, collectAttentionPanes } from '@/lib/attention'
import { displayState, type AgentPaneState } from '@/lib/agent-state/rollup'
import type { DisplayState } from '@/lib/agent-state/types'
import type { LayoutNode } from '@/lib/layout-tree'

// Narrow store selectors for components that used to subscribe to the whole
// `byId` / `active` maps. Each returns plain values or flat arrays/records of
// primitives, so `useShallow` keeps the previous result (and skips the
// re-render) whenever the slice a component shows did not change. Many agents
// flip working <-> idle constantly; those flips must not re-render every tab,
// the attention badge or the prompt library.

/** The attention badge's two counts. */
export function attentionCounts(
  workspaces: ReadonlyArray<{ layout: LayoutNode }>,
  byId: Record<string, AgentPaneState>
): { blocked: number; done: number } {
  return attentionCount(collectAttentionPanes(workspaces, byId))
}

/** Display state per pane of one workspace tab; the active tab shows no dot
 *  and so selects nothing. */
export function paneDisplays(
  ids: readonly string[],
  byId: Record<string, AgentPaneState>,
  active: boolean
): Array<DisplayState | undefined> {
  return active ? [] : ids.map((id) => displayState(byId[id]))
}

/** Output-activity flag per pane of one workspace tab (same rule). */
export function paneOutputs(
  ids: readonly string[],
  activity: Record<string, boolean>,
  active: boolean
): boolean[] {
  return active ? [] : ids.map((id) => activity[id] === true)
}

/** Per-pane "agent recognised" flags for the prompt library; nothing while
 *  the dialog is closed. */
export function recognisedPanes(
  byId: Record<string, AgentPaneState | undefined>,
  open: boolean
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!open) return out
  for (const [id, st] of Object.entries(byId)) {
    out[id] = st?.state !== undefined && st.state !== 'unknown'
  }
  return out
}

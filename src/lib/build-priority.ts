import { collectLeaves, type LayoutNode } from '@/lib/layout-tree'

/** localStorage key of Settings → Terminal "Lower build priority". */
export const BUILD_PRIORITY_KEY = 'swarmterm.lowerBuildPriority'

/** On unless the user switched it off (absent or unreadable ⇒ on). */
export function readLowerBuildPriority(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(BUILD_PRIORITY_KEY) !== 'false'
  } catch {
    return true
  }
}

export function storeLowerBuildPriority(storage: Pick<Storage, 'setItem'>, on: boolean): void {
  try {
    storage.setItem(BUILD_PRIORITY_KEY, on ? 'true' : 'false')
  } catch {
    // Private mode / quota: the in-memory value still applies this session.
  }
}

/**
 * Terminal ids of every pane in a workspace that opted out
 * (`normalBuildPriority`), sorted so callers can compare a joined key and only
 * push to Rust when the set really changed.
 */
export function exemptTerminalIds(
  workspaces: readonly { layout: LayoutNode; normalBuildPriority?: boolean }[]
): string[] {
  const ids: string[] = []
  for (const ws of workspaces) {
    if (!ws.normalBuildPriority) continue
    for (const leaf of collectLeaves(ws.layout)) ids.push(leaf.terminalId)
  }
  return ids.sort()
}

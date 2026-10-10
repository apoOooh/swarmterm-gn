import type { SavedWorkspace, SavedNode, SavedLeaf } from './saved-workspaces'
import { templateById, type AgentAvailabilityMap } from './templates'
import type { ShellAvailabilityMap } from './terminal-pref'

export interface SavedWorkspaceInspection { rootAvailable: boolean; panes: { directoryAvailable: boolean; sessionAvailable: boolean }[] }
export function savedLeaves(node: SavedNode): SavedLeaf[] { return node.type === 'leaf' ? [node] : node.children.flatMap(savedLeaves) }

/** A missing session is never silently substituted by another conversation. */
export function prepareSavedWorkspace(saved: SavedWorkspace, inspection: SavedWorkspaceInspection, agents: AgentAvailabilityMap, shells: ShellAvailabilityMap): { saved: SavedWorkspace; warnings: string[] } {
  if (!inspection.rootAvailable) throw new Error(`Working folder is unavailable: ${saved.cwd}`)
  const warnings: string[] = []
  let i = 0
  const convert = (node: SavedNode): SavedNode => {
    if (node.type === 'split') return { ...node, children: [convert(node.children[0]), convert(node.children[1])] }
    const status = inspection.panes[i++]
    const next = { ...node }
    if (!status) throw new Error('Could not verify the saved workspace. Please try again.')
    if (!status.directoryAvailable) {
      next.cwd = saved.cwd; delete next.worktreeBranch; delete next.sessionId
      warnings.push('A missing pane folder was replaced by the working folder; its agent starts fresh.')
    } else if (next.sessionId && !status.sessionAvailable) {
      delete next.sessionId
      warnings.push('A saved session is no longer available; its agent starts fresh.')
    }
    if (templateById(next.agentId).id !== next.agentId || agents[next.agentId] === false) {
      next.agentId = 'terminal'; delete next.sessionId; delete next.launchMode
      warnings.push('An unavailable agent was replaced by a plain terminal.')
    }
    if (next.shellId !== 'default' && shells[next.shellId] === false) {
      next.shellId = 'default'
      warnings.push('An unavailable shell was replaced by the default shell.')
    }
    return next
  }
  return { saved: { ...saved, layout: convert(saved.layout) }, warnings: [...new Set(warnings)] }
}

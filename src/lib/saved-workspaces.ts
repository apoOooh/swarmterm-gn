/** Only workspace structure and CLI session references cross this boundary. */
import { collectLeaves, type LayoutNode } from '@/lib/layout-tree'
import { KNOWN_SHELLS, type ShellId } from '@/lib/terminal-pref'
import { isValidSessionId } from '@/lib/resume-command'
import { templateById } from '@/lib/templates'
import { sanitizePaneName } from '@/lib/pane-address'
import { sanitizePaneColor, sanitizePaneIcon } from '@/lib/pane-identity'
import type { Workspace } from '@/store/app-store'
import type { AccountSelection } from '@/lib/agent-accounts'

export const SAVED_WORKSPACES_KEY = 'swarmterm-saved-workspaces'
export const MAX_SAVED_WORKSPACES = 24
export interface SavedLeaf {
  type: 'leaf'
  agentId: string
  accountId?: string
  shellId: ShellId
  cwd: string
  launchMode?: string
  worktreeBranch?: string
  sessionId?: string
  name?: string
  /** Pane identity icon + color (lib/pane-identity); re-sanitised on load. */
  icon?: string
  color?: string
  /**
   * The pane's last runtime id: the key a pane that survived in the
   * terminal host (SWA-56) is reattached by. It doubles as the pane's MCP
   * bearer (`SWARMTERM_SESSION`), which authorises only while that pane
   * lives and is already in its own environment — the same user boundary
   * as this storage.
   */
  terminalId?: string
}
/** Overrides for a saved pane that is reattached: the host, not the
 *  (possibly stale) snapshot, knows its current agent and folder. */
export interface ReattachLeaf { terminalId: string; agentId?: string; cwd?: string }
export type SavedNode = SavedLeaf | { type: 'split'; direction: 'horizontal' | 'vertical'; sizes: [number, number]; children: [SavedNode, SavedNode] }
/** `accountSelections`: the workspace's account choice for split panes. */
export interface SavedWorkspace { id: string; name: string; cwd: string; layout: SavedNode; worktreeMode: boolean; updatedAt: number; autoOpen?: number; accountSelections?: Record<string, AccountSelection> }
export interface SavedStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }

function validSession(agent: string, id: string | undefined): string | undefined {
  return id && isValidSessionId(agent, id) ? id : undefined
}

/**
 * `paneIds`: keep each pane's `terminalId` as the reattach key (SWA-56). Only
 * while the terminal host is on: without it nothing can reattach, and the id
 * doubles as the pane's MCP bearer, so it is not stored for nothing.
 */
export function toSaved(ws: Workspace, shell: ShellId, now: number, paneIds = false): SavedWorkspace | undefined {
  if (!ws.savedId) return undefined
  const convert = (node: LayoutNode): SavedNode => {
    if (node.type === 'split') return { type: 'split', direction: node.direction, sizes: [...node.sizes], children: [convert(node.children[0]), convert(node.children[1])] }
    const agentId = node.agentId ?? 'terminal'
    return {
      type: 'leaf', agentId, shellId: node.shellId ?? shell, cwd: node.cwd ?? ws.cwd,
      ...(node.accountId ? { accountId: node.accountId } : {}),
      ...(node.launchMode ? { launchMode: node.launchMode } : {}),
      ...(node.worktreeBranch ? { worktreeBranch: node.worktreeBranch } : {}),
      ...(node.name ? { name: node.name } : {}),
      ...(node.icon ? { icon: node.icon } : {}),
      ...(node.color ? { color: node.color } : {}),
      ...(paneIds && validTerminalId(node.terminalId) ? { terminalId: node.terminalId } : {}),
      ...(validSession(agentId, node.sessionId ?? node.resumeSessionId) ? { sessionId: validSession(agentId, node.sessionId ?? node.resumeSessionId) } : {})
    }
  }
  return { id: ws.savedId, name: ws.name, cwd: ws.cwd, layout: convert(ws.layout), worktreeMode: ws.worktreeMode, updatedAt: now, ...(ws.accountSelections ? { accountSelections: ws.accountSelections } : {}) }
}

function validTerminalId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id)
}

/** `reattach` names the saved panes still running in the terminal host. */
export function fromSaved(saved: SavedWorkspace, uid: () => string, reattach?: (leaf: SavedLeaf) => ReattachLeaf | undefined): Workspace {
  const convert = (node: SavedNode): LayoutNode => {
    if (node.type === 'split') return { type: 'split', id: uid(), direction: node.direction, sizes: [...node.sizes], children: [convert(node.children[0]), convert(node.children[1])] }
    const live = reattach?.(node)
    const savedAgent = templateById(node.agentId).id
    const agentId = live?.agentId ? templateById(live.agentId).id : savedAgent
    // A session belongs to the agent it was recorded for.
    const sessionId = agentId === savedAgent ? validSession(agentId, node.sessionId) : undefined
    return { type: 'leaf', id: uid(), terminalId: live?.terminalId ?? uid(), agentId, accountId: node.accountId, shellId: node.shellId, cwd: live?.cwd || node.cwd, launchMode: agentId === savedAgent ? node.launchMode : undefined, worktreeBranch: node.worktreeBranch, ...(node.name ? { name: node.name } : {}), ...(node.icon ? { icon: node.icon } : {}), ...(node.color ? { color: node.color } : {}), ...(sessionId ? { resumeSessionId: sessionId, sessionId } : {}) }
  }
  const layout = convert(saved.layout)
  return { id: uid(), savedId: saved.id, name: saved.name, cwd: saved.cwd, layout, focusedLeafId: collectLeaves(layout)[0].id, broadcastActive: false, broadcastLeafIds: [], worktreeMode: saved.worktreeMode, ...(saved.accountSelections ? { accountSelections: saved.accountSelections } : {}) }
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 32768 }
/** Keeps only well-formed selections; a since-deleted account id is harmless
 *  (splitAccountFor ignores ids that match no profile). */
function parseSelections(value: unknown): Record<string, AccountSelection> | undefined {
  if (!object(value)) return undefined
  const kept: Record<string, AccountSelection> = {}
  for (const [agentId, selection] of Object.entries(value)) {
    if (agentId !== 'claude-code' && agentId !== 'codex' || !object(selection)) continue
    if (selection.mode === 'round-robin') kept[agentId] = { mode: 'round-robin' }
    else if (selection.mode === 'fixed' && text(selection.accountId)) kept[agentId] = { mode: 'fixed', accountId: selection.accountId }
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}
function parseNode(value: unknown, depth = 0): SavedNode | undefined {
  if (!object(value) || depth > 64) return undefined
  if (value.type === 'leaf') {
    if (!text(value.agentId) || !text(value.cwd) || !KNOWN_SHELLS.some(s => s.id === value.shellId)) return undefined
    return { type: 'leaf', agentId: value.agentId, cwd: value.cwd, shellId: value.shellId as ShellId,
      ...(text(value.accountId) ? { accountId: value.accountId } : {}),
      ...(text(value.launchMode) ? { launchMode: value.launchMode } : {}),
      ...(text(value.worktreeBranch) ? { worktreeBranch: value.worktreeBranch } : {}),
      ...(typeof value.name === 'string' && sanitizePaneName(value.name) ? { name: sanitizePaneName(value.name) } : {}),
      ...(typeof value.icon === 'string' && sanitizePaneIcon(value.icon) ? { icon: sanitizePaneIcon(value.icon) } : {}),
      ...(typeof value.color === 'string' && sanitizePaneColor(value.color) ? { color: sanitizePaneColor(value.color) } : {}),
      ...(validTerminalId(value.terminalId) ? { terminalId: value.terminalId } : {}),
      ...(text(value.sessionId) && isValidSessionId(value.agentId, value.sessionId) ? { sessionId: value.sessionId } : {}) }
  }
  if (value.type !== 'split' || !['horizontal', 'vertical'].includes(String(value.direction)) || !Array.isArray(value.sizes) || value.sizes.length !== 2 || !value.sizes.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) || !Array.isArray(value.children) || value.children.length !== 2) return undefined
  const a = parseNode(value.children[0], depth + 1), b = parseNode(value.children[1], depth + 1)
  return a && b ? { type: 'split', direction: value.direction as 'horizontal' | 'vertical', sizes: value.sizes as [number, number], children: [a, b] } : undefined
}

export function readSaved(storage: Pick<SavedStorage, 'getItem'>): SavedWorkspace[] {
  const raw = storage.getItem(SAVED_WORKSPACES_KEY)
  if (raw === null) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { return [] }
  if (object(value) && typeof value.version === 'number' && value.version > 1) throw new Error('Saved workspaces use a newer format. Update the app to save changes.')
  if (!object(value) || value.version !== 1 || !Array.isArray(value.workspaces)) return []
  const seen = new Set<string>()
  const list: SavedWorkspace[] = []
  for (const item of value.workspaces) {
    if (!object(item) || !text(item.id) || seen.has(item.id) || !text(item.name) || !text(item.cwd) || typeof item.worktreeMode !== 'boolean' || typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)) continue
    const layout = parseNode(item.layout)
    if (!layout) continue
    seen.add(item.id)
    const autoOpen = typeof item.autoOpen === 'number' && Number.isInteger(item.autoOpen) && item.autoOpen >= 0 ? { autoOpen: item.autoOpen } : {}
    const accountSelections = parseSelections(item.accountSelections)
    list.push({ id: item.id, name: item.name, cwd: item.cwd, worktreeMode: item.worktreeMode, updatedAt: item.updatedAt, layout, ...autoOpen, ...(accountSelections ? { accountSelections } : {}) })
  }
  return capSaved(list)
}
/** Newest first, at most MAX_SAVED_WORKSPACES; startup workspaces are never evicted by newer ones. */
function capSaved(list: SavedWorkspace[]): SavedWorkspace[] {
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  const pinned = sorted.filter(w => w.autoOpen !== undefined)
  const room = Math.max(0, MAX_SAVED_WORKSPACES - pinned.length)
  const keep = new Set([...pinned, ...sorted.filter(w => w.autoOpen === undefined).slice(0, room)])
  return sorted.filter(w => keep.has(w))
}
export function storeSaved(storage: Pick<SavedStorage, 'setItem'>, list: SavedWorkspace[]): void {
  storage.setItem(SAVED_WORKSPACES_KEY, JSON.stringify({ version: 1, workspaces: list }))
}
export function upsertSaved(list: SavedWorkspace[], entry: SavedWorkspace): SavedWorkspace[] {
  // Live snapshots (`toSaved`) don't know the startup flag; it belongs to the stored entry.
  const previous = list.find(w => w.id === entry.id)
  if (!('autoOpen' in entry) && previous?.autoOpen !== undefined) entry = { ...entry, autoOpen: previous.autoOpen }
  return capSaved([entry, ...list.filter(w => w.id !== entry.id)])
}

/** Workspaces opened on app start, in their startup order. */
export function autoOpenList(list: SavedWorkspace[]): SavedWorkspace[] {
  return list.filter(w => w.autoOpen !== undefined).sort((a, b) => a.autoOpen! - b.autoOpen!)
}
function renumber(list: SavedWorkspace[], order: string[]): SavedWorkspace[] {
  return list.map(w => {
    const i = order.indexOf(w.id)
    if (i >= 0) return { ...w, autoOpen: i }
    const { autoOpen: _drop, ...rest } = w
    return rest
  })
}
export function setAutoOpen(list: SavedWorkspace[], id: string, on: boolean): SavedWorkspace[] {
  const order = autoOpenList(list).map(w => w.id).filter(x => x !== id)
  if (on && list.some(w => w.id === id)) order.push(id)
  return renumber(list, order)
}
export function moveAutoOpen(list: SavedWorkspace[], id: string, delta: -1 | 1): SavedWorkspace[] {
  const order = autoOpenList(list).map(w => w.id), i = order.indexOf(id), j = i + delta
  if (i < 0 || j < 0 || j >= order.length) return list
  ;[order[i], order[j]] = [order[j], order[i]]
  return renumber(list, order)
}

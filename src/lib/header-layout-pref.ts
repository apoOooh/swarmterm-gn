/**
 * User preference for the pane header: the order of its items and which of
 * them are "core" (always kept in the row) versus allowed to collapse into the
 * overflow row. Zoom and close are not part of this — they stay fixed at the
 * far right of every header.
 */

export const HEADER_ITEMS = [
  { id: 'agent', label: 'Agent & mode' },
  { id: 'account', label: 'Account' },
  { id: 'title', label: 'Title' },
  { id: 'folder', label: 'Folder' },
  { id: 'shell', label: 'Shell' },
  { id: 'war-room', label: 'War Room status' },
  { id: 'worktree', label: 'Worktree branch' },
  { id: 'ctx', label: 'Context usage' },
  { id: 'broadcast', label: 'Broadcast' },
  { id: 'thread', label: 'Conversation thread' },
  { id: 'handoff', label: 'Handoff brief' },
  { id: 'split-right', label: 'Split right' },
  { id: 'split-down', label: 'Split down' },
  { id: 'float', label: 'Float pane' },
  { id: 'drawer', label: 'Move to drawer' }
] as const

export type HeaderItemId = (typeof HEADER_ITEMS)[number]['id']

export interface HeaderLayoutPref {
  /** Display order; among non-core items it is also the hide order (last hides first). */
  order: HeaderItemId[]
  core: HeaderItemId[]
}

/** The title soaks up the row's slack and anchors the drag handle — always core. */
export const ALWAYS_CORE: HeaderItemId = 'title'

export const DEFAULT_HEADER_LAYOUT: HeaderLayoutPref = {
  order: HEADER_ITEMS.map(i => i.id),
  core: ['agent', 'title', 'folder']
}

/**
 * Collapse ranking of the untouched default layout (lower survives longer) —
 * the order the header shipped with before it was configurable: shell →
 * worktree → ctx → war room → account → actions. Display order puts account
 * next to the agent, so position alone can't express it; once the user
 * reorders anything, their list governs instead.
 */
// A new header item needs an entry here too (the Record type enforces it).
const DEFAULT_HIDE_RANK: Record<HeaderItemId, number> = {
  agent: 0, title: 0, folder: 0,
  shell: 1, worktree: 2, ctx: 3, 'war-room': 4, account: 5,
  broadcast: 6, thread: 7, handoff: 8, 'split-right': 9, 'split-down': 10, float: 11, drawer: 12
}

export const HEADER_LAYOUT_STORAGE_KEY = 'cc-pane-header-layout'

const KNOWN = new Set<string>(HEADER_ITEMS.map(i => i.id))
const isId = (v: unknown): v is HeaderItemId => typeof v === 'string' && KNOWN.has(v)

/**
 * Repair any stored shape: drop unknown/duplicate ids, and slot items the user
 * has never seen (added in a later version) back in after their default
 * predecessor, so an upgrade never silently loses a control.
 */
export function normalizeHeaderLayout(raw: unknown): HeaderLayoutPref {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const order: HeaderItemId[] = []
  if (Array.isArray(obj.order)) for (const v of obj.order) if (isId(v) && !order.includes(v)) order.push(v)
  DEFAULT_HEADER_LAYOUT.order.forEach((id, idx) => {
    if (order.includes(id)) return
    const prev = DEFAULT_HEADER_LAYOUT.order.slice(0, idx).reverse().find(p => order.includes(p))
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id)
  })
  const core = Array.isArray(obj.core)
    ? order.filter(id => (obj.core as unknown[]).includes(id))
    : order.filter(id => DEFAULT_HEADER_LAYOUT.core.includes(id))
  if (!core.includes(ALWAYS_CORE)) core.push(ALWAYS_CORE)
  return { order, core }
}

/** Move `id` to `targetId`'s position (dnd-kit `arrayMove` semantics). */
export function moveHeaderItem(pref: HeaderLayoutPref, id: HeaderItemId, targetId: HeaderItemId): HeaderLayoutPref {
  const from = pref.order.indexOf(id)
  const to = pref.order.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return pref
  const order = [...pref.order]
  order.splice(from, 1)
  order.splice(to, 0, id)
  return { ...pref, order }
}

export function toggleHeaderCore(pref: HeaderLayoutPref, id: HeaderItemId): HeaderLayoutPref {
  if (id === ALWAYS_CORE) return pref
  const core = pref.core.includes(id) ? pref.core.filter(c => c !== id) : [...pref.core, id]
  return { ...pref, core: pref.order.filter(o => core.includes(o)) }
}

export interface HeaderLayoutStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function readStoredHeaderLayout(storage: HeaderLayoutStorage): HeaderLayoutPref {
  const raw = storage.getItem(HEADER_LAYOUT_STORAGE_KEY)
  if (raw === null) return normalizeHeaderLayout(DEFAULT_HEADER_LAYOUT)
  try {
    return normalizeHeaderLayout(JSON.parse(raw))
  } catch {
    return normalizeHeaderLayout(DEFAULT_HEADER_LAYOUT)
  }
}

export function storeHeaderLayout(storage: HeaderLayoutStorage, pref: HeaderLayoutPref): void {
  storage.setItem(HEADER_LAYOUT_STORAGE_KEY, JSON.stringify(pref))
}

/**
 * Apply the preference to the header's item list: configured items take the
 * user's order, `pinned` = core and `priority` = position, so among collapsible
 * items the later one in the list hides first — except in the default order,
 * which keeps `DEFAULT_HIDE_RANK`. Items the preference doesn't know (zoom,
 * close) pass through unchanged at the end.
 */
export function applyHeaderLayout<T extends { id: string; priority: number; pinned?: boolean }>(
  items: T[],
  pref: HeaderLayoutPref
): T[] {
  const rank = new Map<string, number>(pref.order.map((id, i) => [id, i]))
  const core = new Set<string>(pref.core)
  const isDefaultOrder = pref.order.join() === DEFAULT_HEADER_LAYOUT.order.join()
  const hideRank = (id: string): number =>
    isDefaultOrder ? DEFAULT_HIDE_RANK[id as HeaderItemId] : rank.get(id)!
  const configured = items
    .filter(i => rank.has(i.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
    .map(i => ({ ...i, pinned: core.has(i.id), priority: hideRank(i.id) }))
  return [...configured, ...items.filter(i => !rank.has(i.id))]
}

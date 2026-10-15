/** How the worktree chip renders at a given header width. */
export type WorktreeDisplay = 'full' | 'name-trunc' | 'icon' | 'hidden'

export interface HeaderLevel {
  /** false → the folder trigger collapses to an icon (no path label). */
  showFolderPath: boolean
  /** false → the shell trigger collapses to an icon (no shell label). */
  showShellLabel: boolean
  worktree: WorktreeDisplay
}

/**
 * Resolve which header chips render at full detail for a given header width.
 *
 * Priority — survives longest as the pane narrows: title > folder > shell >
 * worktree. The *title* is never governed here; it always renders and truncates
 * in CSS. As width shrinks, chips degrade in reverse-priority order:
 *   worktree name truncates → worktree becomes icon-only → shell sheds its
 *   label → folder sheds its path. Thresholds are px widths of the whole header
 *   row, tuned against the 28px pane header (see the design spec).
 */
export function resolveHeaderLevel(widthPx: number, hasWorktree: boolean): HeaderLevel {
  const showFolderPath = widthPx >= 180
  const showShellLabel = widthPx >= 220

  let worktree: WorktreeDisplay = 'hidden'
  if (hasWorktree) {
    if (widthPx >= 320) worktree = 'full'
    else if (widthPx >= 260) worktree = 'name-trunc'
    else worktree = 'icon'
  }

  return { showFolderPath, showShellLabel, worktree }
}

/** Compact folder label for the header — the trailing path segment only. */
export function shortenPath(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** One header element as the overflow resolver sees it. */
export interface HeaderOverflowItem {
  id: string
  /** Estimated rendered width in px (incl. its share of the row gap). */
  width: number
  /** Lower = more important; collapsible items are kept in this order. */
  priority: number
  /** Pinned items always render in the row (title, close, …). */
  pinned?: boolean
}

export interface HeaderOverflow {
  /** Ids that render in the row, in their original order. */
  visible: string[]
  /** Ids moved to the expandable second row, most important first. */
  hidden: string[]
}

/** Width reserved for the ⋯ chip once anything overflows. */
export const OVERFLOW_CHIP_PX = 24

/**
 * Decide which header items fit in a row of `widthPx`. Pinned items are always
 * kept (the title truncates in CSS to make room); collapsible items fill the
 * rest strictly by priority — the first one that doesn't fit hides itself and
 * everything less important, so the row never shows a minor button while a
 * more important one sits in the overflow. Once anything hides, the ⋯ chip's
 * width is reserved too.
 */
export function resolveHeaderOverflow(widthPx: number, items: HeaderOverflowItem[]): HeaderOverflow {
  const total = items.reduce((sum, i) => sum + i.width, 0)
  if (total <= widthPx) return { visible: items.map(i => i.id), hidden: [] }

  let budget = widthPx - OVERFLOW_CHIP_PX
  for (const i of items) if (i.pinned) budget -= i.width

  const kept = new Set<string>()
  const ranked = items.filter(i => !i.pinned).sort((a, b) => a.priority - b.priority)
  let full = false
  for (const i of ranked) {
    if (!full && i.width <= budget) { kept.add(i.id); budget -= i.width }
    else full = true
  }

  return {
    visible: items.filter(i => i.pinned || kept.has(i.id)).map(i => i.id),
    hidden: ranked.filter(i => !kept.has(i.id)).map(i => i.id)
  }
}

/**
 * Pane identity: a user-chosen icon + name (+ optional color) that says who a
 * pane is ("Reviewer", "Backend"), shown next to — not instead of — the
 * automatic title the agent sets. The name is the existing `leaf.name`
 * (BUZ-5), so voice addressing keeps working unchanged.
 */

import { MEMBER_COLORS } from '@/lib/war-room-identity'
import { sanitizePaneName } from '@/lib/pane-address'

/** Suggested lucide icons shown before the user searches (static imports in
 *  PaneIdentityIcon, so they render instantly). Any other lucide icon name is
 *  valid too and loads on demand. */
export const PANE_ICONS = [
  'bot', 'brain', 'code', 'bug', 'search', 'shield', 'wrench', 'rocket',
  'book-open', 'pencil', 'test-tube', 'database', 'server', 'cloud', 'globe', 'terminal',
  'git-branch', 'eye', 'zap', 'star', 'flag', 'crown', 'heart', 'flame',
  'sparkles', 'compass', 'hammer', 'package', 'palette', 'layers', 'list-checks', 'message-square',
  'user', 'users', 'cat', 'dog', 'bird', 'fish', 'sun', 'moon'
] as const

export type PaneIconId = (typeof PANE_ICONS)[number]

/** War Room member colors first (a pane reads the same in both places), then
 *  ten more mid-tone hues that stay legible on both themes. Orange is left
 *  out on purpose: it is the War Room's execute marker. */
export const PANE_COLORS = [
  ...MEMBER_COLORS,
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#a855f7', // purple
  '#f472b6', // pink
  '#a3e635', // lime
  '#eab308', // gold
  '#a16207', // brown
  '#94a3b8' // slate
]

export interface PaneIdentity {
  name?: string
  icon?: string
  color?: string
  /** Also tint the pane's top bar with `color`. */
  headerTint?: boolean
}

/** Longest emoji sequence accepted (ZWJ families, flags, skin tones fit). */
const MAX_EMOJI_LENGTH = 16

export function isPaneIconId(icon: string): icon is PaneIconId {
  return (PANE_ICONS as readonly string[]).includes(icon)
}

/** Shape of a lucide icon name ("git-branch", "circle-dot-2"). Whether the
 *  name exists is checked at render time; an unknown one renders nothing. */
export function isIconNameShape(icon: string): boolean {
  return icon.length <= 48 && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(icon)
}

/**
 * A lucide icon name, or a short emoji. Anything else (mixed text, spaces,
 * long strings) is rejected so an icon can never smuggle in a second name.
 */
export function sanitizePaneIcon(raw: string | undefined): string | undefined {
  const icon = raw?.trim() ?? ''
  if (icon === '') return undefined
  if (isIconNameShape(icon)) return icon
  if (icon.length > MAX_EMOJI_LENGTH) return undefined
  if (/[\p{L}\p{N}\s]/u.test(icon)) return undefined
  return /\p{Extended_Pictographic}/u.test(icon) ? icon : undefined
}

/** An accepted icon that is an emoji rather than an icon name. */
export function isEmojiIcon(raw: string | undefined): boolean {
  const icon = sanitizePaneIcon(raw)
  return icon !== undefined && !isIconNameShape(icon)
}

/**
 * Icon names matching a search, best first: exact, then prefix, then
 * substring matches. Every word of the query must appear ("arrow up" finds
 * "arrow-big-up"). Capped at `limit` — the full set is ~2000 icons.
 */
export function searchIconNames(names: readonly string[], query: string, limit: number): string[] {
  const words = query.toLowerCase().split(/[\s-]+/).filter(Boolean)
  if (words.length === 0) return []
  const joined = words.join('-')
  const rank = (name: string): number => (name === joined ? 0 : name.startsWith(words[0]) ? 1 : 2)
  return names
    .filter((name) => words.every((w) => name.includes(w)))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
    .slice(0, limit)
}

/** Only palette colors: keeps every identity legible on both themes. */
export function sanitizePaneColor(raw: string | undefined): string | undefined {
  const color = raw?.trim().toLowerCase()
  return color && PANE_COLORS.includes(color) ? color : undefined
}

/** Cleans a whole identity; every field independently clears to undefined. */
export function sanitizePaneIdentity(raw: PaneIdentity): {
  name: string | undefined
  icon: string | undefined
  color: string | undefined
  headerTint: true | undefined
} {
  const color = sanitizePaneColor(raw.color)
  return {
    name: sanitizePaneName(raw.name ?? ''),
    icon: sanitizePaneIcon(raw.icon),
    color,
    // A tint without a color has nothing to paint with.
    headerTint: color && raw.headerTint === true ? true : undefined
  }
}

/** Alpha (hex) of the top-bar tint: enough to tell panes apart, low enough
 *  that the header's text and controls keep their contrast in both themes. */
const HEADER_TINT_ALPHA = '2e'

/**
 * Inline style for a tinted pane header, or undefined for the default look.
 * The bottom border takes the full color so the bar still reads as tinted
 * when the background blends in; a zoomed pane keeps its zoom border.
 */
export function paneHeaderTintStyle(
  color: string | undefined,
  headerTint: boolean | undefined,
  zoomed = false
): { backgroundColor: string; borderBottomColor?: string } | undefined {
  const c = sanitizePaneColor(color)
  if (!c || headerTint !== true) return undefined
  return zoomed ? { backgroundColor: `${c}${HEADER_TINT_ALPHA}` } : { backgroundColor: `${c}${HEADER_TINT_ALPHA}`, borderBottomColor: c }
}

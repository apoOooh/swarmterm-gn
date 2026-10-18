/**
 * Pane identity: a user-chosen icon + name (+ optional color) that says who a
 * pane is ("Reviewer", "Backend"), shown next to — not instead of — the
 * automatic title the agent sets. The name is the existing `leaf.name`
 * (BUZ-5), so voice addressing keeps working unchanged.
 */

import { MEMBER_COLORS } from '@/lib/war-room-identity'
import { sanitizePaneName } from '@/lib/pane-address'

/** Curated lucide icons (kebab-case ids, mapped to components in PaneIdentityIcon). */
export const PANE_ICONS = [
  'bot', 'brain', 'code', 'bug', 'search', 'shield', 'wrench', 'rocket',
  'book-open', 'pencil', 'test-tube', 'database', 'server', 'cloud', 'globe', 'terminal',
  'git-branch', 'eye', 'zap', 'star', 'flag', 'crown', 'heart', 'flame',
  'sparkles', 'compass', 'hammer', 'package', 'palette', 'layers', 'list-checks', 'message-square',
  'user', 'users', 'cat', 'dog', 'bird', 'fish', 'sun', 'moon'
] as const

export type PaneIconId = (typeof PANE_ICONS)[number]

/** Same palette as War Room members, so a pane reads the same in both places. */
export const PANE_COLORS = MEMBER_COLORS

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

/**
 * A curated icon id, or a short emoji. Anything else (letters, digits, long
 * text) is rejected so an icon can never smuggle in a second name.
 */
export function sanitizePaneIcon(raw: string | undefined): string | undefined {
  const icon = raw?.trim() ?? ''
  if (icon === '') return undefined
  if (isPaneIconId(icon)) return icon
  if (icon.length > MAX_EMOJI_LENGTH) return undefined
  if (/[\p{L}\p{N}\s]/u.test(icon)) return undefined
  return /\p{Extended_Pictographic}/u.test(icon) ? icon : undefined
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

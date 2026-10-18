/**
 * Spoken pane addressing (BUZ-5): "Pane 2: …" or "Pane Backend: …" from
 * buzzkey resolves to exactly one terminal of the active workspace, or to an
 * error. Titles are not unique (four "Claude Code · swarmterm" panes are
 * normal), so a name that matches more than one pane is refused rather than
 * guessed — a dictation typed into the wrong agent is worse than none.
 */

export interface AddressablePane {
  terminalId: string
  /** 1-based, order of the open panes in the navbar list. */
  number: number
  /** Resolved header title (agent-set title or agent display name). */
  title: string
  /** User-given pane name, if any. */
  name?: string
}

export type PaneAddressResult = { terminalId: string } | { error: 'no-target' | 'ambiguous' | 'no-focus' }

export const MAX_PANE_NAME = 40

const NUMBER_WORDS: Record<string, number> = {
  eins: 1, ein: 1, eine: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fuenf: 5, funf: 5, sechs: 6, sieben: 7,
  acht: 8, neun: 9, zehn: 10, elf: 11, zwoelf: 12, zwolf: 12,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12
}

export function normalizePaneName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** A spoken pane number ("2", "zwei", "Nummer 2", "number two"), else null. */
export function parsePaneNumber(raw: string): number | null {
  const words = normalizePaneName(raw).split(' ')
  if (words.length === 2 && (words[0] === 'nummer' || words[0] === 'number' || words[0] === 'nr')) words.shift()
  if (words.length !== 1) return null
  const word = words[0]
  if (/^\d{1,3}$/.test(word)) {
    const n = Number(word)
    return n > 0 ? n : null
  }
  return NUMBER_WORDS[word] ?? null
}

function unique(matches: AddressablePane[]): PaneAddressResult | null {
  if (matches.length === 1) return { terminalId: matches[0].terminalId }
  return matches.length > 1 ? { error: 'ambiguous' } : null
}

export function resolvePaneAddress(target: string, panes: AddressablePane[]): PaneAddressResult {
  const n = parsePaneNumber(target)
  if (n !== null) {
    const pane = panes.find((p) => p.number === n)
    return pane ? { terminalId: pane.terminalId } : { error: 'no-target' }
  }
  const key = normalizePaneName(target)
  if (!key) return { error: 'no-target' }
  const byName = panes.filter((p) => p.name && normalizePaneName(p.name) === key)
  const byTitle = panes.filter((p) => normalizePaneName(p.title) === key)
  // A user name wins over titles — but if another pane carries that word as
  // its title (a program can set its own title), the user cannot tell which
  // one they will hit, so it is refused like any other duplicate.
  if (byName.length === 1 && byTitle.some((p) => p.terminalId !== byName[0].terminalId)) return { error: 'ambiguous' }
  return unique(byName) ?? unique(byTitle) ?? { error: 'no-target' }
}

/** Cleans a typed pane name; undefined clears it (back to the automatic title). */
export function sanitizePaneName(raw: string): string | undefined {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PANE_NAME).trim()
  // A name that reads as a number would be unreachable by voice.
  if (!name || parsePaneNumber(name) !== null) return undefined
  return name
}

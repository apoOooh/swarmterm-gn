import { Unicode11Addon } from '@xterm/addon-unicode11'

/** Minimal Terminal surface needed to switch the width tables. */
interface UnicodeCapableTerminal {
  loadAddon(addon: Unicode11Addon): void
  unicode: { activeVersion: string }
}

/** Load the Unicode 11 width tables and make them active (needs allowProposedApi). */
export function enableUnicode11(term: UnicodeCapableTerminal): void {
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
}

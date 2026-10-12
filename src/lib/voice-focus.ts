import { shouldReturnFocus, type FocusedElementInfo } from '@/lib/terminal-focus'

/**
 * Which pane owns the keyboard right now, for pinning a dictation (SWA-12).
 * The selected pane alone is not enough: with Settings, Welcome, the file
 * editor, a search field or any dialog holding the keyboard, the user is not
 * talking to a shell, and guessing would type into a pane they are not
 * looking at. Any doubt answers `null` ("no-focus") instead.
 */
export interface DictationFocusInput {
  /** This window is the OS foreground window (popouts answer for themselves). */
  windowFocused: boolean
  settingsOpen: boolean
  welcomeFocused: boolean
  /** The focused pane shows a file editor rather than its terminal. */
  editorPane: boolean
  /** `describeFocusedElement(document.activeElement)`. */
  focused: FocusedElementInfo | null
  /** True when the active element is the xterm textarea of `terminalId`. */
  inTerminal: boolean
  terminalId: string | null
}

export function dictationTarget(i: DictationFocusInput): string | null {
  if (!i.windowFocused || i.settingsOpen || i.welcomeFocused || i.editorPane) return null
  if (!i.terminalId) return null
  if (i.focused?.modalOpen) return null
  // Focus inside the terminal itself, or parked on chrome that would hand it
  // back to the terminal anyway (a tab title after a click). Inputs, menus,
  // dialogs and editor controls keep it.
  return i.inTerminal || shouldReturnFocus(i.focused) ? i.terminalId : null
}

import { describe, expect, it } from 'vitest'
import { dictationTarget, type DictationFocusInput } from './voice-focus'

const base: DictationFocusInput = {
  windowFocused: true,
  settingsOpen: false,
  welcomeFocused: false,
  editorPane: false,
  focused: { tagName: 'TEXTAREA', isContentEditable: false, inOverlay: false },
  inTerminal: true,
  terminalId: 't1'
}

describe('dictationTarget', () => {
  it('pins the focused terminal when it owns the keyboard', () => {
    expect(dictationTarget(base)).toBe('t1')
  })

  it('accepts focus parked on chrome that hands back to the terminal', () => {
    expect(dictationTarget({ ...base, inTerminal: false, focused: { tagName: 'DIV', isContentEditable: false, inOverlay: false } })).toBe('t1')
  })

  it('refuses when settings, welcome or an editor own the keyboard', () => {
    expect(dictationTarget({ ...base, settingsOpen: true })).toBeNull()
    expect(dictationTarget({ ...base, welcomeFocused: true })).toBeNull()
    expect(dictationTarget({ ...base, editorPane: true })).toBeNull()
  })

  it('refuses inputs, overlays and open modals', () => {
    const input = { tagName: 'INPUT', isContentEditable: false, inOverlay: false }
    expect(dictationTarget({ ...base, inTerminal: false, focused: input })).toBeNull()
    expect(dictationTarget({ ...base, inTerminal: false, focused: { ...input, tagName: 'DIV', inOverlay: true } })).toBeNull()
    expect(dictationTarget({ ...base, focused: { ...input, tagName: 'TEXTAREA', modalOpen: true } })).toBeNull()
  })

  it('refuses when the window is not focused or no pane is selected', () => {
    expect(dictationTarget({ ...base, windowFocused: false })).toBeNull()
    expect(dictationTarget({ ...base, terminalId: null })).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { isEditableElement, shouldReturnFocus, type FocusedElementInfo } from './terminal-focus'

function info(over: Partial<FocusedElementInfo> = {}): FocusedElementInfo {
  return { tagName: 'DIV', isContentEditable: false, inOverlay: false, ...over }
}

describe('shouldReturnFocus', () => {
  it('lets the file tree and editor chrome retain keyboard focus', () => {
    expect(shouldReturnFocus(info({ tagName: 'DIV', keyboardOwner: true }))).toBe(false)
  })
  it('returns focus when nothing is focused', () => {
    expect(shouldReturnFocus(null)).toBe(true)
  })

  it('returns focus when the body holds it', () => {
    expect(shouldReturnFocus(info({ tagName: 'BODY' }))).toBe(true)
  })

  it('returns focus when a chrome div holds it (a tab, a navbar item, a pane root)', () => {
    expect(shouldReturnFocus(info({ tagName: 'DIV' }))).toBe(true)
  })

  it('returns focus when a plain button holds it (a close X, the + button)', () => {
    expect(shouldReturnFocus(info({ tagName: 'BUTTON' }))).toBe(true)
  })

  it('stands down for a text input — the workspace rename field', () => {
    expect(shouldReturnFocus(info({ tagName: 'INPUT' }))).toBe(false)
  })

  it('stands down for textarea and select', () => {
    expect(shouldReturnFocus(info({ tagName: 'TEXTAREA' }))).toBe(false)
    expect(shouldReturnFocus(info({ tagName: 'SELECT' }))).toBe(false)
  })

  it('stands down for a contenteditable element', () => {
    expect(shouldReturnFocus(info({ isContentEditable: true }))).toBe(false)
  })

  it('stands down while an open menu or dialog owns focus', () => {
    expect(shouldReturnFocus(info({ tagName: 'DIV', inOverlay: true }))).toBe(false)
    expect(shouldReturnFocus(info({ tagName: 'BUTTON', inOverlay: true }))).toBe(false)
  })

  it('is case-insensitive about tag names', () => {
    expect(shouldReturnFocus(info({ tagName: 'input' }))).toBe(false)
  })
})

describe('modal dialogs own the keyboard (review P1)', () => {
  it('never returns focus to a terminal while a modal dialog is open', () => {
    expect(shouldReturnFocus({ tagName: 'TEXTAREA', isContentEditable: false, inOverlay: false, modalOpen: true })).toBe(false)
    expect(shouldReturnFocus({ tagName: 'DIV', isContentEditable: false, inOverlay: false, modalOpen: true })).toBe(false)
    expect(shouldReturnFocus(null, true)).toBe(false)
  })
})

describe('isEditableElement', () => {
  const el = (tagName: string, opts: { inXterm?: boolean; editable?: boolean } = {}) => ({
    tagName,
    isContentEditable: opts.editable ?? false,
    closest: (sel: string) => (sel === '.xterm' && opts.inXterm ? ({} as Element) : null)
  })

  it('is true for text fields and contenteditable', () => {
    expect(isEditableElement(el('INPUT'))).toBe(true)
    expect(isEditableElement(el('textarea'))).toBe(true)
    expect(isEditableElement(el('DIV', { editable: true }))).toBe(true)
  })

  it("is false for xterm's helper textarea, plain elements and null", () => {
    expect(isEditableElement(el('TEXTAREA', { inXterm: true }))).toBe(false)
    expect(isEditableElement(el('BUTTON'))).toBe(false)
    expect(isEditableElement(null)).toBe(false)
  })
})

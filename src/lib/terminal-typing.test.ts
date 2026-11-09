import { describe, expect, it } from 'vitest'
import { classifyInput, createSubmitIntent, isBracketedPaste } from './terminal-typing'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** The exact frame xterm's `paste()` emits when the app enabled bracketed paste. */
const paste = (inner: string) => `${PASTE_START}${inner}${PASTE_END}`

describe('classifyInput', () => {
  it('treats printable characters and backspace as editing', () => {
    expect(classifyInput('a')).toBe('edit')
    expect(classifyInput('hello')).toBe('edit')
    expect(classifyInput('\x7f')).toBe('edit') // backspace
    expect(classifyInput('  ')).toBe('edit')
  })

  it('treats a multi-character IME commit as editing', () => {
    expect(classifyInput('xin chào')).toBe('edit')
    expect(classifyInput('日本語')).toBe('edit')
  })

  it('treats Enter, Ctrl+C, Ctrl+U and a bare Esc as ending the line', () => {
    expect(classifyInput('\r')).toBe('submit')
    expect(classifyInput('\x03')).toBe('submit')
    expect(classifyInput('\x15')).toBe('submit')
    expect(classifyInput('\x1b')).toBe('submit')
  })

  it('treats any payload containing a CR as ending the line', () => {
    expect(classifyInput('do the thing\r')).toBe('submit')
    expect(classifyInput('line one\rline two')).toBe('submit')
  })

  it('treats LF (Shift+Enter in an agent pane, Ctrl+J) as editing: the line stays unsent (SWA-88)', () => {
    expect(classifyInput('\n')).toBe('edit')
    expect(classifyInput('line one\nline two')).toBe('edit')
  })

  it('treats escape SEQUENCES as navigation, not as Esc', () => {
    // This is the whole point of the module: \x1b is Esc, \x1b[ starts a
    // sequence. Getting it wrong makes every arrow key clear the dirty flag.
    expect(classifyInput('\x1b[A')).toBe('nav') // up
    expect(classifyInput('\x1b[D')).toBe('nav') // left
    expect(classifyInput('\x1b[H')).toBe('nav') // home
    expect(classifyInput('\x1bOP')).toBe('nav') // F1 in application mode
  })

  it('treats an empty payload as navigation (nothing was typed)', () => {
    expect(classifyInput('')).toBe('nav')
  })

  it('treats a bracketed paste as editing, whatever the frame contains', () => {
    // xterm wraps the clipboard in \x1b[200~ … \x1b[201~ whenever the foreground
    // app enabled bracketed paste (every agent TUI does) and the app inserts the
    // payload LITERALLY — the embedded CRs do not submit. Reading the frame as
    // an escape sequence (nav) or as a submit disarms the hold exactly while
    // the pasted text is still sitting unsent on the line.
    expect(classifyInput(paste('deploy prod'))).toBe('edit')
    expect(classifyInput(paste('line one\rline two'))).toBe('edit')
    expect(classifyInput(paste('line one\nline two'))).toBe('edit')
    expect(classifyInput(paste('a\r'))).toBe('edit')
    expect(classifyInput(paste('\x1b[A'))).toBe('edit')
    expect(classifyInput(paste(''))).toBe('edit')
  })

  it('keeps unframed payloads on the old rules (bracketed paste off, or half a frame)', () => {
    expect(classifyInput('a\rb')).toBe('submit')
    expect(classifyInput('\x1b[200~a\rb')).toBe('submit') // no closer ⇒ not a frame
    expect(classifyInput('\x1b[200~x')).toBe('nav') // no closer ⇒ plain escape sequence
    expect(classifyInput('\x1b[A')).toBe('nav')
    expect(classifyInput('\x1b')).toBe('submit')
  })
})

describe('isBracketedPaste', () => {
  it('matches only a frame closed on both ends', () => {
    expect(isBracketedPaste(paste('deploy prod'))).toBe(true)
    expect(isBracketedPaste(paste('line one\rline two'))).toBe(true)
    expect(isBracketedPaste(paste(''))).toBe(true)
    expect(isBracketedPaste(`${PASTE_START}x`)).toBe(false)
    expect(isBracketedPaste(`x${PASTE_END}`)).toBe(false)
    expect(isBracketedPaste(PASTE_START)).toBe(false)
    expect(isBracketedPaste(PASTE_END)).toBe(false)
    expect(isBracketedPaste('\x1b[A')).toBe(false)
    expect(isBracketedPaste('x')).toBe(false)
    expect(isBracketedPaste('')).toBe(false)
  })
})

describe('createSubmitIntent (SWA-88)', () => {
  const key = (over: Partial<KeyboardEvent> = {}) =>
    ({ type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over }) as KeyboardEvent

  it('the CR of a plain Enter keydown xterm handled is a real submit, once', () => {
    const intent = createSubmitIntent()
    intent.key(key(), true)
    expect(intent.take('\r')).toBe(true)
    expect(intent.take('\r')).toBe(false)
  })

  it('Shift+Enter / the agent newline (LF) is no submit', () => {
    const intent = createSubmitIntent()
    intent.key(key({ shiftKey: true }), false)
    expect(intent.take('\n')).toBe(false)
  })

  it('Ctrl+J is no submit', () => {
    const intent = createSubmitIntent()
    intent.key(key({ key: 'j', ctrlKey: true }), true)
    expect(intent.take('\n')).toBe(false)
  })

  it('a bracketed paste with CR is no submit, even right after an Enter keydown', () => {
    const intent = createSubmitIntent()
    intent.key(key(), true)
    expect(intent.take(paste('a\rb\r'))).toBe(false)
    expect(intent.take('\r')).toBe(false)
  })

  it('an xterm protocol answer is no submit, and a CR without a key is none either', () => {
    const intent = createSubmitIntent()
    expect(intent.take('\x1b[?1;2c')).toBe(false)
    expect(intent.take('\r')).toBe(false)
  })

  it('an Enter xterm did not handle, a keyup or an IME Enter arms nothing', () => {
    const intent = createSubmitIntent()
    intent.key(key(), false)
    expect(intent.take('\r')).toBe(false)
    intent.key(key({ type: 'keyup' }), true)
    expect(intent.take('\r')).toBe(false)
    intent.key({ ...key(), isComposing: true } as KeyboardEvent, true)
    expect(intent.take('\r')).toBe(false)
  })

  it('disarms at the end of the task: a later CR cannot borrow the intent', async () => {
    const intent = createSubmitIntent()
    intent.key(key(), true)
    await Promise.resolve()
    expect(intent.take('\r')).toBe(false)
  })
})

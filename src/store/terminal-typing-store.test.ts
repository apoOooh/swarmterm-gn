import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalTypingStore } from './terminal-typing-store'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
  useTerminalTypingStore.setState({ lastKeyAt: {}, dirty: {}, submitAnchor: {}, inputRev: {} })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('noteInput', () => {
  it('marks the line dirty and stamps the time on an edit', () => {
    useTerminalTypingStore.getState().noteInput('t1', 'a')
    const s = useTerminalTypingStore.getState()
    expect(s.dirty['t1']).toBe(true)
    expect(s.lastKeyAt['t1']).toBe(Date.now())
  })

  it('clears both dirty and the timestamp on a submit', () => {
    // Deliberately changed behaviour: an earlier version kept lastKeyAt on
    // submit, which meant shouldDeferDelivery's focused-and-recent arm held a
    // delivery for a further TYPING_QUIET_MS after every Enter — pressing
    // Enter never actually released a hold. Submit must look exactly like
    // clearTyping: nothing pending, no recency to re-check.
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', 'abc')
    vi.advanceTimersByTime(1000)
    s.noteInput('t1', '\r')
    const after = useTerminalTypingStore.getState()
    expect(after.dirty['t1']).toBeUndefined()
    expect(after.lastKeyAt['t1']).toBeUndefined()
  })

  it('leaves dirty untouched on navigation but refreshes the timestamp', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', 'abc')
    vi.advanceTimersByTime(500)
    s.noteInput('t1', '\x1b[A')
    const after = useTerminalTypingStore.getState()
    expect(after.dirty['t1']).toBe(true)
    expect(after.lastKeyAt['t1']).toBe(Date.now())
  })

  it('arms dirty on a bracketed paste, single- or multi-line, until a real Enter', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', '\x1b[200~deploy prod\x1b[201~')
    expect(useTerminalTypingStore.getState().dirty['t1']).toBe(true)
    s.clearTyping('t1')
    vi.advanceTimersByTime(500)
    s.noteInput('t1', '\x1b[200~line one\rline two\x1b[201~')
    const after = useTerminalTypingStore.getState()
    expect(after.dirty['t1']).toBe(true)
    expect(after.lastKeyAt['t1']).toBe(Date.now())
    // The Enter the user presses AFTER the paste is the submit that releases.
    s.noteInput('t1', '\r')
    expect(useTerminalTypingStore.getState().dirty['t1']).toBeUndefined()
  })

  it('keeps terminals independent', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', 'a')
    // A submit with no prior entry is a no-op (same as clearTyping on a
    // terminal that never typed) — no dirty flag is created for it.
    s.noteInput('t2', '\r')
    const after = useTerminalTypingStore.getState()
    expect(after.dirty['t1']).toBe(true)
    expect(after.dirty['t2']).toBeUndefined()
  })
})

describe('clearTyping', () => {
  it('drops both entries for the terminal and leaves others alone', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', 'a')
    s.noteInput('t2', 'b')
    s.clearTyping('t1')
    const after = useTerminalTypingStore.getState()
    expect(after.dirty['t1']).toBeUndefined()
    expect(after.lastKeyAt['t1']).toBeUndefined()
    expect(after.dirty['t2']).toBe(true)
  })

  it('is a no-op for a terminal that never typed', () => {
    const before = useTerminalTypingStore.getState()
    before.clearTyping('ghost')
    const after = useTerminalTypingStore.getState()
    expect(after.dirty).toBe(before.dirty)
    expect(after.lastKeyAt).toBe(before.lastKeyAt)
  })
})

describe('markDraft', () => {
  it('marks a dictated draft as the user typing and returns its stamp', () => {
    const stamp = useTerminalTypingStore.getState().markDraft('t1', 5)
    const s = useTerminalTypingStore.getState()
    expect(stamp).toBe(5)
    expect(s.dirty['t1']).toBe(true)
    expect(s.lastKeyAt['t1']).toBe(5)
  })

  it('a later submit clears the stamp so a delayed Enter can see it', () => {
    useTerminalTypingStore.getState().markDraft('t1', 5)
    useTerminalTypingStore.getState().noteInput('t1', '\r')
    expect(useTerminalTypingStore.getState().lastKeyAt['t1']).toBeUndefined()
  })
})

describe('submit anchor / takeSubmit (SWA-88)', () => {
  const anchorOf = (id: string) => useTerminalTypingStore.getState().submitAnchor[id]

  it('only the CR of a plain Enter key makes an anchor', () => {
    const s = useTerminalTypingStore.getState()
    for (const data of ['\x03', '\x15', '\x1b', 'abc']) s.noteInput('t1', data, true)
    expect(anchorOf('t1')).toBeUndefined()
    s.noteInput('t1', '\r')
    expect(anchorOf('t1')).toBeUndefined()
    s.noteInput('t1', '\r', true)
    expect(anchorOf('t1')?.at).toBe(Date.now())
  })

  it('Shift+Enter (LF) is an edit: the line stays dirty, no anchor', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', 'first line')
    s.noteInput('t1', '\n')
    expect(useTerminalTypingStore.getState().dirty['t1']).toBe(true)
    expect(anchorOf('t1')).toBeUndefined()
    expect(s.takeSubmit('t1', Date.now(), 15_000)).toBeUndefined()
  })

  it('Ctrl+J (LF, even flagged as a key) makes no anchor', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', 'x')
    s.noteInput('t1', '\n', true)
    expect(useTerminalTypingStore.getState().dirty['t1']).toBe(true)
    expect(s.takeSubmit('t1', Date.now(), 15_000)).toBeUndefined()
  })

  it('a bracketed paste with CR inside makes no anchor', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', '\x1b[200~line one\rline two\r\x1b[201~', true)
    expect(useTerminalTypingStore.getState().dirty['t1']).toBe(true)
    expect(s.takeSubmit('t1', Date.now(), 15_000)).toBeUndefined()
  })

  it('an xterm protocol answer (DA, DSR) makes no anchor', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', '\x1b[?1;2c')
    s.noteInput('t1', '\x1b[24;1R')
    expect(s.takeSubmit('t1', Date.now(), 15_000)).toBeUndefined()
  })

  it('is taken once and only while fresh, and returns the revision of that Enter', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', '\r', true)
    const rev = useTerminalTypingStore.getState().inputRev['t1']
    vi.advanceTimersByTime(1000)
    expect(s.takeSubmit('t1', Date.now(), 5000)).toBe(rev)
    expect(s.takeSubmit('t1', Date.now(), 5000)).toBeUndefined()
    s.noteInput('t1', '\r', true)
    vi.advanceTimersByTime(6000)
    expect(s.takeSubmit('t1', Date.now(), 5000)).toBeUndefined()
  })

  it('a dictated draft is no submit, and clearTyping (respawn, dispose) drops the anchor', () => {
    const s = useTerminalTypingStore.getState()
    s.markDraft('t1', Date.now())
    expect(anchorOf('t1')).toBeUndefined()
    s.noteInput('t1', '\r', true)
    s.clearTyping('t1')
    expect(s.takeSubmit('t1', Date.now(), 5000)).toBeUndefined()
  })

  it('every input moves the revision on — Esc, Ctrl+C, nav, a new Enter — and markDraft does not', () => {
    const s = useTerminalTypingStore.getState()
    const rev = () => useTerminalTypingStore.getState().inputRev['t1']
    s.noteInput('t1', '\r', true)
    const seen = new Set([rev()])
    for (const data of ['\x1b', '\x03', '\x15', '\x1b[A', 'a', '\r']) {
      s.noteInput('t1', data)
      expect(seen.has(rev())).toBe(false)
      seen.add(rev())
    }
    const before = rev()
    s.markDraft('t1', Date.now())
    expect(rev()).toBe(before)
  })

  it('a clear never resets the revision, not even for a disposed and reused id', () => {
    const s = useTerminalTypingStore.getState()
    s.noteInput('t1', 'a')
    const before = useTerminalTypingStore.getState().inputRev['t1']!
    s.clearTyping('t1')
    const afterClear = useTerminalTypingStore.getState().inputRev['t1']!
    expect(afterClear).toBeGreaterThan(before)
    s.clearTyping('t1')
    expect(useTerminalTypingStore.getState().inputRev['t1']!).toBeGreaterThan(afterClear)
  })
})

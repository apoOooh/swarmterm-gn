import { describe, expect, it, vi } from 'vitest'
import { PTY_RESIZE_DEBOUNCE_MS, createResizeDebouncer } from './resize-debounce'

function harness() {
  const timers = new Map<number, () => void>()
  let next = 1
  const send = vi.fn()
  const d = createResizeDebouncer({
    send,
    setTimer: (fn, ms) => {
      expect(ms).toBe(PTY_RESIZE_DEBOUNCE_MS)
      const h = next++
      timers.set(h, fn)
      return h
    },
    clearTimer: (h) => void timers.delete(h as number)
  })
  const fire = (): void => {
    const fns = [...timers.values()]
    timers.clear()
    fns.forEach((fn) => fn())
  }
  return { d, send, fire, pending: () => timers.size }
}

describe('createResizeDebouncer', () => {
  it('sends only the last size of a burst, after the wait', () => {
    const h = harness()
    h.d.schedule(100, 30)
    h.d.schedule(90, 30)
    h.d.schedule(80, 28)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.pending()).toBe(1)
    h.fire()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith(80, 28)
  })

  it('sends nothing when the burst ends at the size already sent', () => {
    const h = harness()
    h.d.flush(100, 30)
    h.d.schedule(90, 30)
    h.d.schedule(100, 30)
    h.fire()
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('flush sends immediately and drops anything queued', () => {
    const h = harness()
    h.d.schedule(90, 30)
    h.d.flush(120, 40)
    expect(h.send).toHaveBeenCalledWith(120, 40)
    expect(h.pending()).toBe(0)
    h.fire()
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('cancel drops a queued size', () => {
    const h = harness()
    h.d.schedule(90, 30)
    h.d.cancel()
    h.fire()
    expect(h.send).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { cleanupWhenResolved, latestRequest } from './listener-cleanup'

describe('cleanupWhenResolved', () => {
  it('removes a listener that resolves after cleanup', async () => {
    const un = vi.fn()
    let resolve!: (fn: () => void) => void
    const cleanup = cleanupWhenResolved(new Promise((r) => (resolve = r)))
    cleanup()
    resolve(un)
    await Promise.resolve()
    await Promise.resolve()
    expect(un).toHaveBeenCalledTimes(1)
  })

  it('removes a listener that resolved before cleanup', async () => {
    const un = vi.fn()
    const cleanup = cleanupWhenResolved(Promise.resolve(un))
    await Promise.resolve()
    await Promise.resolve()
    expect(un).not.toHaveBeenCalled()
    cleanup()
    expect(un).toHaveBeenCalledTimes(1)
  })

  it('swallows a rejected registration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cleanup = cleanupWhenResolved(Promise.reject(new Error('ipc')), 'x')
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalled()
    cleanup()
    warn.mockRestore()
  })
})

describe('latestRequest', () => {
  it('only the newest request is current', () => {
    const req = latestRequest()
    const a = req.begin()
    const b = req.begin()
    expect(a()).toBe(false)
    expect(b()).toBe(true)
  })

  it('dispose invalidates the in-flight request', () => {
    const req = latestRequest()
    const a = req.begin()
    req.dispose()
    expect(a()).toBe(false)
  })
})

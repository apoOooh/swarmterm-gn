import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchStatus = vi.fn()
vi.mock('@/tauri/terminal-host', () => ({ getTerminalHostStatus: () => fetchStatus() }))

import { getHostStatusSnapshot, setHostStatus, subscribeHostStatus } from './host-status-store'
import type { TerminalHostStatus } from '@/tauri/terminal-host'

const status = (s: object): TerminalHostStatus => s as TerminalHostStatus

describe('host status store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchStatus.mockReset()
    fetchStatus.mockReturnValue(new Promise(() => {}))
  })
  afterEach(() => vi.useRealTimers())

  it('keeps a local set while mounted', () => {
    const unsub = subscribeHostStatus(() => {})
    try {
      setHostStatus(status({ enabled: true }))
      expect(getHostStatusSnapshot()).toEqual({ enabled: true })
    } finally {
      // A failed expect must not leave the listener for the next test.
      unsub()
    }
    expect(getHostStatusSnapshot()).toBeNull()
  })

  it('drops a set that resolves after unmount', () => {
    const unsub = subscribeHostStatus(() => {})
    unsub()
    setHostStatus(status({ enabled: true }))
    expect(getHostStatusSnapshot()).toBeNull()
    const listener = vi.fn()
    const unsub2 = subscribeHostStatus(listener)
    try {
      expect(getHostStatusSnapshot()).toBeNull()
      expect(listener).not.toHaveBeenCalled()
    } finally {
      unsub2()
    }
  })
})

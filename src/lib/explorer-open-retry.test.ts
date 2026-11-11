import { describe, expect, it } from 'vitest'
import { OPEN_RETRY_WINDOW_MS, openRetryDelay } from './explorer-open-retry'

describe('openRetryDelay', () => {
  const notReady = 'Terminal is not ready; try again when its shell has started'

  it('retries quickly at first, then slower', () => {
    expect(openRetryDelay(notReady, 0)).toBe(250)
    expect(openRetryDelay(notReady, 4_999)).toBe(250)
    expect(openRetryDelay(notReady, 5_000)).toBe(1_000)
  })

  it('outlasts the terminal host fallback (15 s) and then gives up', () => {
    expect(openRetryDelay(notReady, 16_000)).toBe(1_000)
    expect(OPEN_RETRY_WINDOW_MS).toBeGreaterThan(15_000)
    expect(openRetryDelay(notReady, OPEN_RETRY_WINDOW_MS)).toBeNull()
  })

  it('never retries other errors', () => {
    expect(openRetryDelay('Access denied', 0)).toBeNull()
    expect(openRetryDelay(new Error('Terminal is NOT READY in the selected folder'), 0)).toBe(250)
  })
})

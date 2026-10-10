import { expect, it } from 'vitest'
import { registerCloseGuard, withCloseGuard } from './close-guard'
it('does not close until the dirty document guard accepts', async () => {
  let answer!: (allowed: boolean) => void; let closed = false
  const off = registerCloseGuard(() => new Promise((r) => { answer = r }))
  withCloseGuard(['pane'], () => { closed = true }); expect(closed).toBe(false)
  answer(false); await Promise.resolve(); expect(closed).toBe(false)
  withCloseGuard(['pane'], () => { closed = true }); answer(true); await Promise.resolve(); expect(closed).toBe(true)
  off()
})

import { describe, expect, it, vi } from 'vitest'
import { chooseQuit, keepTerminalsDialog } from './quit-flow'

describe('chooseQuit', () => {
  it('closes without asking when no pane runs in the host', async () => {
    const ask = vi.fn()
    expect(await chooseQuit(async () => 0, ask)).toBe('close')
    expect(ask).not.toHaveBeenCalled()
  })

  it('closes without asking when the count fails', async () => {
    const ask = vi.fn()
    expect(await chooseQuit(async () => { throw new Error('no host') }, ask)).toBe('close')
    expect(ask).not.toHaveBeenCalled()
  })

  it('maps the answers', async () => {
    expect(await chooseQuit(async () => 2, async () => 'keep')).toBe('keep')
    expect(await chooseQuit(async () => 2, async () => 'close')).toBe('close')
    expect(await chooseQuit(async () => 2, async () => null)).toBe('cancel')
  })
})

describe('keepTerminalsDialog', () => {
  it('offers closing first, so Enter keeps the old behaviour', () => {
    const dialog = keepTerminalsDialog(3)
    expect(dialog.title).toBe('Keep terminals running?')
    expect(dialog.choices.map((c) => c.value)).toEqual(['close', 'keep'])
  })
})

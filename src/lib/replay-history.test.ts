import { describe, expect, it, vi } from 'vitest'
import { REPLAY_TRUNCATED_NOTE, writeReplayHistory } from './replay-history'

describe('writeReplayHistory', () => {
  it('never attaches the ack callback to the truncation note', () => {
    const calls: { data: string | Uint8Array; cb?: () => void }[] = []
    const term = { write: (data: string | Uint8Array, cb?: () => void) => { calls.push({ data, cb }) } }
    const onParsed = vi.fn()
    const data = new TextEncoder().encode('history')
    writeReplayHistory(term, data, true, onParsed)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ data: REPLAY_TRUNCATED_NOTE, cb: undefined })
    expect(calls[1].data).toBe(data)
    expect(calls[1].cb).toBe(onParsed)
  })

  it('writes only the history when nothing was truncated', () => {
    const write = vi.fn()
    const onParsed = vi.fn()
    writeReplayHistory({ write }, new Uint8Array([104]), false, onParsed)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][1]).toBe(onParsed)
  })
})

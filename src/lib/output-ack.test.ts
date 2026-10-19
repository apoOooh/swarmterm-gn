import { describe, expect, it, vi } from 'vitest'
import { ACK_CHUNK, OutputAcker } from './output-ack'

describe('OutputAcker', () => {
  it('batches acks per chunk instead of one per write', () => {
    const send = vi.fn()
    const a = new OutputAcker(send, 100)
    a.setSpawnId('g1')
    for (let i = 0; i < 9; i++) a.parsed(10)
    expect(send).not.toHaveBeenCalled()
    a.parsed(15)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith('g1', 105)
    for (let i = 0; i < 25; i++) a.parsed(10)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls.reduce((n, c) => n + (c[1] as number), 0)).toBe(305)
  })

  it('holds acks until the generation id is known', () => {
    const send = vi.fn()
    const a = new OutputAcker(send, 100)
    a.parsed(250)
    expect(send).not.toHaveBeenCalled()
    a.setSpawnId('g2')
    expect(send).toHaveBeenCalledWith('g2', 250)
  })

  it('defaults to 64 KB chunks', () => {
    const send = vi.fn()
    const a = new OutputAcker(send)
    a.setSpawnId('g')
    a.parsed(ACK_CHUNK - 1)
    expect(send).not.toHaveBeenCalled()
    a.parsed(1)
    expect(send).toHaveBeenCalledWith('g', ACK_CHUNK)
  })
})

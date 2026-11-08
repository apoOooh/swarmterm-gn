import { describe, expect, it, vi } from 'vitest'
import { ACK_CHUNK, OutputAcker, utf8Length } from './output-ack'

describe('OutputAcker', () => {
  /** Writes `sizes`, running each handed-out callback at once (parsed). */
  const feed = (a: OutputAcker, sizes: number[]): number => {
    let callbacks = 0
    for (const n of sizes) {
      const cb = a.write(n)
      if (cb) { callbacks++; cb() }
    }
    return callbacks
  }

  it('batches acks and parse callbacks per chunk instead of one per write', () => {
    const send = vi.fn()
    const a = new OutputAcker(send, 100)
    a.setSpawnId('g1')
    expect(feed(a, Array(9).fill(10))).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(feed(a, [15])).toBe(1)
    expect(send).toHaveBeenLastCalledWith('g1', 105)
    expect(feed(a, Array(25).fill(10))).toBe(2)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls.reduce((n, c) => n + (c[1] as number), 0)).toBe(305)
  })

  it('acks only once the marked write is parsed, covering earlier writes', () => {
    const send = vi.fn()
    const a = new OutputAcker(send, 100)
    a.setSpawnId('g')
    expect(a.write(60)).toBeUndefined()
    const cb = a.write(60)
    expect(cb).toBeDefined()
    expect(send).not.toHaveBeenCalled()
    cb?.()
    expect(send).toHaveBeenCalledWith('g', 120)
    cb?.()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('holds acks until the generation id is known', () => {
    const send = vi.fn()
    const a = new OutputAcker(send, 100)
    feed(a, [250])
    expect(send).not.toHaveBeenCalled()
    a.setSpawnId('g2')
    expect(send).toHaveBeenCalledWith('g2', 250)
  })

  it('keeps ACK_CHUNK at 256 KB, half of the Rust FLOW_LOW (host/src/flow.rs pins the pair)', () => {
    expect(ACK_CHUNK).toBe(256 * 1024)
  })

  it('defaults to ACK_CHUNK chunks', () => {
    const send = vi.fn()
    const a = new OutputAcker(send)
    a.setSpawnId('g')
    feed(a, [ACK_CHUNK - 1])
    expect(send).not.toHaveBeenCalled()
    feed(a, [1])
    expect(send).toHaveBeenCalledWith('g', ACK_CHUNK)
  })
})

describe('utf8Length', () => {
  it('matches TextEncoder for ASCII, 2-, 3- and 4-byte characters', () => {
    for (const s of ['', 'abc', 'h\u00e9', '\u2500\u2502', '\u{1F600}x', 'a\u00e9\u20ac\u{1F600}']) {
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).byteLength)
    }
  })
  it('matches TextEncoder on seeded random strings, pairs at the edges included', () => {
    let seed = 12345
    const rnd = (n: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n }
    const pool = ['a', '\u00e9', '\u2500', '\u65e5', '\u{1F600}', '\x1b', '\n']
    for (let k = 0; k < 200; k++) {
      let s = '\u{1F600}'
      for (let i = rnd(64); i > 0; i--) s += pool[rnd(pool.length)]
      s += '\u{1F680}'
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).byteLength)
    }
  })
})
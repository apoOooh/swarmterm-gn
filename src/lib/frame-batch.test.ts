import { describe, expect, it } from 'vitest'
import { createFrameBatch } from './frame-batch'

function fakeRaf(): { raf: (cb: () => void) => number; flush: () => void; pending: () => number } {
  let queue: Array<() => void> = []
  return {
    raf: (cb) => {
      queue.push(cb)
      return queue.length
    },
    flush: () => {
      const run = queue
      queue = []
      run.forEach((cb) => cb())
    },
    pending: () => queue.length
  }
}

describe('createFrameBatch', () => {
  it('runs each scheduled item once on the next frame', () => {
    const f = fakeRaf()
    const seen: string[] = []
    const batch = createFrameBatch<string>((item) => seen.push(item), f.raf)
    batch.schedule('a')
    batch.schedule('b')
    batch.schedule('a')
    expect(seen).toEqual([])
    expect(f.pending()).toBe(1)
    f.flush()
    expect(seen).toEqual(['a', 'b'])
  })

  it('skips cancelled items', () => {
    const f = fakeRaf()
    const seen: string[] = []
    const batch = createFrameBatch<string>((item) => seen.push(item), f.raf)
    batch.schedule('a')
    batch.schedule('b')
    batch.cancel('a')
    f.flush()
    expect(seen).toEqual(['b'])
  })

  it('requests a new frame for items scheduled after a flush', () => {
    const f = fakeRaf()
    const seen: string[] = []
    const batch = createFrameBatch<string>((item) => seen.push(item), f.raf)
    batch.schedule('a')
    f.flush()
    batch.schedule('a')
    expect(f.pending()).toBe(1)
    f.flush()
    expect(seen).toEqual(['a', 'a'])
  })

  it('keeps running the rest when one item throws', () => {
    const f = fakeRaf()
    const seen: string[] = []
    const batch = createFrameBatch<string>((item) => {
      if (item === 'bad') throw new Error('boom')
      seen.push(item)
    }, f.raf)
    batch.schedule('bad')
    batch.schedule('ok')
    f.flush()
    expect(seen).toEqual(['ok'])
  })
})

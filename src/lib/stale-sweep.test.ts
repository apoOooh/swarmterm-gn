import { describe, expect, it } from 'vitest'
import { staleKeys } from './stale-sweep'

describe('staleKeys', () => {
  it('returns keys not in the live set', () => {
    expect(staleKeys(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c'])
  })

  it('catches a late entry for a dead id even when the live set did not change', () => {
    const live = new Set(['t1'])
    // A title/preview that arrives for t2 after its pane closed.
    expect(staleKeys(Object.keys({ t1: 'x', t2: 'late' }), live)).toEqual(['t2'])
  })
})

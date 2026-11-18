import { describe, expect, it } from 'vitest'
import { nextChoice } from './choice-hook'

const shape = [{ options: 2, multiSelect: false }]

describe('nextChoice', () => {
  it('opens on a blocked edge with a shape', () => {
    expect(nextChoice(undefined, 'blocked', shape)).toEqual(shape)
  })
  it('keeps the shape across a blocked edge without one', () => {
    expect(nextChoice(shape, 'blocked', undefined)).toBe(shape)
  })
  it('ends on every non-blocked edge', () => {
    for (const s of ['working', 'idle', 'forget'] as const) expect(nextChoice(shape, s, shape)).toBeUndefined()
  })
  it('a new dialog replaces the old shape', () => {
    const next = [{ options: 3, multiSelect: false }]
    expect(nextChoice(shape, 'blocked', next)).toBe(next)
  })
})

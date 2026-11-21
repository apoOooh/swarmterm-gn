import { describe, expect, it } from 'vitest'
import { nextChoice } from './choice-hook'

const shape = [{ options: 2, multiSelect: false }]

describe('nextChoice', () => {
  it('opens on a blocked edge with a shape', () => {
    expect(nextChoice(undefined, 'blocked', shape)).toEqual(shape)
  })
  it('keeps the shape across edges that carry none (Notification, background PostToolUse)', () => {
    for (const s of ['blocked', 'working', 'idle'] as const) expect(nextChoice(shape, s, undefined)).toBe(shape)
  })
  it('ends on another permission request (empty list) and on forget', () => {
    expect(nextChoice(shape, 'blocked', [])).toBeUndefined()
    expect(nextChoice(shape, 'forget', undefined)).toBeUndefined()
  })
  it('a new dialog replaces the old shape', () => {
    const next = [{ options: 3, multiSelect: false }]
    expect(nextChoice(shape, 'blocked', next)).toBe(next)
  })
})

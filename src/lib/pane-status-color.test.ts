import { describe, it, expect } from 'vitest'
import { mixHex, paneStatusTone, WORKING_END, WORKING_START } from './pane-status-color'

describe('mixHex', () => {
  it('returns the endpoints at 0 and 1', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
  })
  it('mixes linearly and clamps', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#ffffff', 3)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', -1)).toBe('#000000')
  })
})

describe('paneStatusTone', () => {
  it('wears no frame while idle, unknown or stateless', () => {
    expect(paneStatusTone('idle', 0, 10)).toBeNull()
    expect(paneStatusTone('unknown', 0, 10)).toBeNull()
    expect(paneStatusTone(undefined, 0, 10)).toBeNull()
  })

  it('shows blocked red and done green regardless of age', () => {
    expect(paneStatusTone('blocked', 999_999, 10)).toEqual({ tone: 'blocked', color: '#f14c4c' })
    expect(paneStatusTone('done', 999_999, 10)).toEqual({ tone: 'done', color: '#23d18b' })
  })

  it('drifts a working pane from yellow to orange over the gradient', () => {
    expect(paneStatusTone('working', 0, 10)?.color).toBe(WORKING_START)
    expect(paneStatusTone('working', 5 * 60_000, 10)?.color).toBe(mixHex(WORKING_START, WORKING_END, 0.5))
    expect(paneStatusTone('working', 10 * 60_000, 10)?.color).toBe(WORKING_END)
    expect(paneStatusTone('working', 60 * 60_000, 10)?.color).toBe(WORKING_END)
  })

  it('stays yellow when the gradient is off', () => {
    expect(paneStatusTone('working', 60 * 60_000, 0)).toEqual({ tone: 'working', color: WORKING_START })
  })
})

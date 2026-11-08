import { describe, it, expect } from 'vitest'
import { WHEEL_PIXELS_PER_STEP, clampZoomOffset, paneFontSize, wheelZoomSteps } from './terminal-zoom'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from './terminal-text'

const LINE = 1
const PAGE = 2

describe('wheelZoomSteps', () => {
  it('one mouse notch up (pixel mode) is one step bigger', () => {
    expect(wheelZoomSteps({ deltaY: -100, deltaMode: 0 }, 0)).toEqual({ steps: 1, carry: 0 })
  })

  it('one notch down is one step smaller', () => {
    expect(wheelZoomSteps({ deltaY: 100, deltaMode: 0 }, 0)).toEqual({ steps: -1, carry: 0 })
  })

  it('accumulates small touchpad deltas until a full step', () => {
    let r = wheelZoomSteps({ deltaY: -30, deltaMode: 0 }, 0)
    expect(r.steps).toBe(0)
    r = wheelZoomSteps({ deltaY: -30, deltaMode: 0 }, r.carry)
    expect(r.steps).toBe(0)
    r = wheelZoomSteps({ deltaY: -50, deltaMode: 0 }, r.carry)
    expect(r.steps).toBe(1)
    expect(r.carry).toBe(-10)
  })

  it('drops the carry when the direction reverses', () => {
    expect(wheelZoomSteps({ deltaY: 40, deltaMode: 0 }, -80)).toEqual({ steps: 0, carry: 40 })
  })

  it('caps one fast flick to a few steps', () => {
    expect(wheelZoomSteps({ deltaY: -100 * 20, deltaMode: 0 }, 0).steps).toBe(3)
  })

  it('normalises line and page delta modes', () => {
    expect(wheelZoomSteps({ deltaY: -3, deltaMode: LINE }, 0).steps).toBe(1)
    expect(wheelZoomSteps({ deltaY: 1, deltaMode: PAGE }, 0).steps).toBe(-1)
  })

  it('ignores a zero delta', () => {
    expect(wheelZoomSteps({ deltaY: 0, deltaMode: 0 }, 0)).toEqual({ steps: 0, carry: 0 })
  })

  it('uses a step size of one mouse notch', () => {
    expect(WHEEL_PIXELS_PER_STEP).toBe(100)
  })
})

describe('paneFontSize / clampZoomOffset', () => {
  it('adds the offset to the global size', () => {
    expect(paneFontSize(13, 3)).toBe(16)
    expect(paneFontSize(13, -2)).toBe(11)
  })

  it('clamps the result into the font size range', () => {
    expect(paneFontSize(13, 100)).toBe(FONT_SIZE_MAX)
    expect(paneFontSize(13, -100)).toBe(FONT_SIZE_MIN)
  })

  it('keeps the offset from running past the range', () => {
    expect(clampZoomOffset(13, 100)).toBe(FONT_SIZE_MAX - 13)
    expect(clampZoomOffset(13, -100)).toBe(FONT_SIZE_MIN - 13)
    expect(clampZoomOffset(13, 2)).toBe(2)
  })
})

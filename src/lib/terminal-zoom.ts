import { FONT_SIZE_MAX, FONT_SIZE_MIN, clampFontSize } from './terminal-text'

/** One classic mouse-wheel notch in WebView2 pixel mode = one px of font size. */
export const WHEEL_PIXELS_PER_STEP = 100
/** A fast flick arrives as one huge delta; capping keeps it from jumping 20 sizes. */
const MAX_STEPS_PER_EVENT = 3
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2

/**
 * Turn one wheel event into font-size steps (scroll up = bigger). Touchpads
 * send many small pixel deltas, so the remainder is carried to the next event
 * instead of rounding each one to a full step; a direction change drops it so
 * reversing reacts at once.
 */
export function wheelZoomSteps(
  event: { deltaY: number; deltaMode: number },
  carry: number
): { steps: number; carry: number } {
  const unit = event.deltaMode === DOM_DELTA_LINE ? WHEEL_PIXELS_PER_STEP / 3
    : event.deltaMode === DOM_DELTA_PAGE ? WHEEL_PIXELS_PER_STEP : 1
  const delta = event.deltaY * unit
  if (delta === 0) return { steps: 0, carry }
  const total = Math.sign(delta) === Math.sign(carry) ? carry + delta : delta
  const whole = Math.trunc(total / WHEEL_PIXELS_PER_STEP)
  const rest = total - whole * WHEEL_PIXELS_PER_STEP
  const capped = Math.max(-MAX_STEPS_PER_EVENT, Math.min(MAX_STEPS_PER_EVENT, whole))
  return { steps: -capped || 0, carry: rest }
}

/** A pane's font size: the global size plus its own zoom offset, kept in range. */
export function paneFontSize(base: number, offset: number): number {
  return clampFontSize(base + offset)
}

/** Keep a pane's offset where it still changes something, so zooming back reacts at once. */
export function clampZoomOffset(base: number, offset: number): number {
  return Math.min(FONT_SIZE_MAX - base, Math.max(FONT_SIZE_MIN - base, offset))
}

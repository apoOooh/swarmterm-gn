import { expect, it } from 'vitest'
import { mediaVersion, reloadStep, resumeAt, type ReloadState } from './media'
it('waits for a regenerated clip to stop changing before reloading it', () => {
  let state: ReloadState = { loaded: undefined, pending: undefined, lastSeq: 0 }
  let step = reloadStep(state, 1, { mtimeMs: 1, size: 100 }); expect(step.action).toBe('reload'); state = step.state
  step = reloadStep(state, 2, { mtimeMs: 2, size: 10 }); expect(step.action).toBe('none'); state = step.state
  step = reloadStep(state, 3, { mtimeMs: 3, size: 50 }); expect(step.action).toBe('none'); state = step.state
  step = reloadStep(state, 4, { mtimeMs: 3, size: 50 }); expect(step.action).toBe('reload')
  expect(reloadStep(step.state, 2, null).action).toBe('none')
  expect(mediaVersion({ mtimeMs: 3.9, size: 50 })).toBe('3-50')
})
it('preserves a valid playback position and handles shortened clips', () => {
  expect(resumeAt(10, 20)).toBe(10); expect(resumeAt(10, 5)).toBe(0); expect(resumeAt(NaN, 20)).toBe(0)
})

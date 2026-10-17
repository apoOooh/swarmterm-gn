import { describe, expect, it } from 'vitest'
import {
  applyDictation,
  builtinReady,
  dictationFailure,
  IDLE,
  type ModelStatus
} from './voice-dictation'

describe('applyDictation', () => {
  it('follows recording → transcribing → idle for one pane', () => {
    const rec = applyDictation(IDLE, { state: 'recording', terminalId: 't1' })
    expect(rec).toEqual({ phase: 'recording', terminalId: 't1' })
    const tr = applyDictation(rec, { state: 'transcribing', terminalId: 't1' })
    expect(tr.phase).toBe('transcribing')
    expect(applyDictation(tr, { state: 'idle', terminalId: 't1' })).toEqual(IDLE)
  })

  it('keeps the pane when a later event omits it', () => {
    const rec = applyDictation(IDLE, { state: 'recording', terminalId: 't1' })
    expect(applyDictation(rec, { state: 'transcribing' }).terminalId).toBe('t1')
  })
})

describe('dictationFailure', () => {
  it('stays silent for user-driven ends', () => {
    expect(dictationFailure(undefined)).toBeNull()
    expect(dictationFailure('user')).toBeNull()
    expect(dictationFailure('superseded')).toBeNull()
  })

  it('explains the reasons a user can act on', () => {
    expect(dictationFailure('model-missing')).toMatch(/download/i)
    expect(dictationFailure('mic-unavailable')).toMatch(/microphone/i)
    expect(dictationFailure('no-focus')).toMatch(/terminal/i)
    expect(dictationFailure('no-speech')).toMatch(/no speech/i)
  })

  it('falls back to the raw reason for anything unknown', () => {
    expect(dictationFailure('weird-thing')).toContain('weird-thing')
  })
})

describe('builtinReady', () => {
  const models: ModelStatus[] = [
    { id: 'base', label: 'Base', bytes: 1, ready: true, downloading: false },
    { id: 'small', label: 'Small', bytes: 1, ready: false, downloading: true }
  ]
  const on = { enabled: true, allowAutoEnter: false, announceTurns: false, builtinEnabled: true, model: 'base', language: 'auto' }

  it('needs Voice, the built-in switch and the selected model on disk', () => {
    expect(builtinReady(on, models)).toBe(true)
    expect(builtinReady({ ...on, enabled: false }, models)).toBe(false)
    expect(builtinReady({ ...on, builtinEnabled: false }, models)).toBe(false)
    expect(builtinReady({ ...on, model: 'small' }, models)).toBe(false)
    expect(builtinReady(on, [])).toBe(false)
    expect(builtinReady(null, models)).toBe(false)
  })
})

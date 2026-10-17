import { describe, expect, it } from 'vitest'
import { claimsReadExcerpt, claimsStopAnnouncement, createTtsStopper, newlyFocusedTerminal, TTS_STOP_THROTTLE_MS } from './voice-tts'

describe('createTtsStopper', () => {
  it('stops on the first keystroke and throttles the rest', () => {
    let t = 1000
    const calls: number[] = []
    const onInput = createTtsStopper(() => calls.push(t), () => t)
    onInput()
    t += 10
    onInput()
    t += TTS_STOP_THROTTLE_MS
    onInput()
    expect(calls).toEqual([1000, 1010 + TTS_STOP_THROTTLE_MS])
  })
})

describe('newlyFocusedTerminal', () => {
  it('reports only a change to another terminal', () => {
    expect(newlyFocusedTerminal('a', 'b')).toBe('b')
    expect(newlyFocusedTerminal(null, 'a')).toBe('a')
    expect(newlyFocusedTerminal('a', 'a')).toBeNull()
    expect(newlyFocusedTerminal('a', null)).toBeNull()
  })
})

describe('announcement shortcuts (SWA-58)', () => {
  const s = (o: Partial<{ enabled: boolean; speakTurns: boolean; allowExcerpts: boolean }>) => ({
    enabled: true,
    speakTurns: false,
    allowExcerpts: false,
    ...o
  })

  it('claims the stop key while either the status voice or excerpts are on', () => {
    expect(claimsStopAnnouncement(undefined)).toBe(false)
    expect(claimsStopAnnouncement(s({}))).toBe(false)
    expect(claimsStopAnnouncement(s({ speakTurns: true }))).toBe(true)
    // Excerpts only, status voice off: an excerpt must still be stoppable.
    expect(claimsStopAnnouncement(s({ allowExcerpts: true }))).toBe(true)
  })

  it('claims the read key only while excerpts are allowed and voice is on', () => {
    expect(claimsReadExcerpt(undefined)).toBe(false)
    expect(claimsReadExcerpt(s({ speakTurns: true }))).toBe(false)
    expect(claimsReadExcerpt(s({ allowExcerpts: true }))).toBe(true)
    expect(claimsReadExcerpt(s({ allowExcerpts: true, enabled: false }))).toBe(false)
  })
})

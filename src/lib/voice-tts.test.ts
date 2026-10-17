import { describe, expect, it } from 'vitest'
import { createTtsStopper, newlyFocusedTerminal, TTS_STOP_THROTTLE_MS } from './voice-tts'

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

import { describe, expect, it } from 'vitest'
import { windowsPtyOption } from './windows-pty'

describe('windowsPtyOption', () => {
  it('is unset off Windows', () => {
    expect(windowsPtyOption(false, 26200)).toBeUndefined()
  })
  it('declares ConPTY with the build number on Windows', () => {
    expect(windowsPtyOption(true, 26200)).toEqual({ backend: 'conpty', buildNumber: 26200 })
  })
  it('still declares ConPTY when the build is unknown', () => {
    expect(windowsPtyOption(true, null)).toEqual({ backend: 'conpty' })
  })
})

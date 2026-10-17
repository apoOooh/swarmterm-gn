import { describe, expect, it } from 'vitest'
import { companionErrorText, companionView, progressText, type CompanionStatus } from './voice-companion'

const base: CompanionStatus = {
  supported: true,
  installed: false,
  dir: 'C:\\Users\\u\\AppData\\Local\\Programs\\buzzkey',
  running: false,
  connected: false,
  version: null,
  canQuit: false,
  autostart: false,
  whisperKeyRunning: false,
  busy: false,
  signingKeyIsTest: false
}

describe('companionView', () => {
  it('offers install when buzzkey is missing', () => {
    const v = companionView(base)
    expect(v.state).toBe('not-installed')
    expect(v.actions).toEqual(['install'])
  })

  it('offers start, autostart and update check when installed but stopped', () => {
    const v = companionView({ ...base, installed: true })
    expect(v.state).toBe('stopped')
    expect(v.actions).toEqual(['start', 'check', 'reinstall'])
    expect(v.showAutostart).toBe(true)
  })

  it('shows the version once connected and quits only with the capability', () => {
    const on = { ...base, installed: true, running: true, connected: true, version: '1.9.1+bk.4' }
    expect(companionView(on).label).toBe('Connected — buzzkey 1.9.1+bk.4')
    expect(companionView(on).actions).toEqual(['check'])
    expect(companionView(on).quitHint).toBe(true)
    expect(companionView({ ...on, canQuit: true }).actions).toEqual(['quit', 'check'])
    expect(companionView({ ...on, canQuit: true }).quitHint).toBe(false)
  })

  it('treats a running buzzkey without a connection as running, not connected', () => {
    const v = companionView({ ...base, installed: true, running: true })
    expect(v.state).toBe('running')
    expect(v.label).toBe('Running, not connected yet')
  })

  it('blocks every action while whisper-key runs or an install is busy', () => {
    const wk = companionView({ ...base, whisperKeyRunning: true })
    expect(wk.state).toBe('whisper-key')
    expect(wk.actions).toEqual([])
    expect(companionView({ ...base, installed: true, busy: true }).actions).toEqual([])
  })

  it('is unavailable off Windows', () => {
    expect(companionView({ ...base, supported: false }).state).toBe('unsupported')
  })
})

describe('companionErrorText', () => {
  it('turns backend reasons into plain sentences', () => {
    expect(companionErrorText('signature-invalid')).toMatch(/signature/i)
    expect(companionErrorText('hash-mismatch:buzzkey.exe')).toMatch(/buzzkey\.exe/)
    expect(companionErrorText('running-quit-in-tray')).toMatch(/tray/)
    expect(companionErrorText('no-signed-release')).toMatch(/signed/)
    expect(companionErrorText('something odd')).toBe('something odd')
  })
})

describe('progressText', () => {
  it('formats downloads in MB and the other phases as words', () => {
    expect(progressText({ phase: 'download', file: 'buzzkey.exe', received: 1_572_864, total: 3_145_728 })).toBe(
      'Downloading buzzkey.exe — 1.5 / 3.0 MB'
    )
    expect(progressText({ phase: 'verify', file: null, received: 0, total: 0 })).toBe('Checking signature…')
    expect(progressText({ phase: 'done', file: null, received: 0, total: 0 })).toBeNull()
  })
})

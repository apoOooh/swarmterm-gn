import { describe, expect, it } from 'vitest'
import { insertRejection, prepareDictationBody, shouldSubmitDictation } from './voice-insert'

describe('prepareDictationBody', () => {
  it('frames bracketed text and turns line breaks into CR', () => {
    expect(prepareDictationBody('fix the\nbug', true)).toBe('\x1b[200~fix the\rbug\x1b[201~')
  })

  it('sanitises before framing so a body cannot close the paste early', () => {
    const body = prepareDictationBody('a\x1b[201~rm -rf /\r\n', true)
    expect(body.startsWith('\x1b[200~')).toBe(true)
    expect(body.endsWith('\x1b[201~')).toBe(true)
    // The only ESCs on the wire are the two framing markers.
    expect(body.split('\x1b').length - 1).toBe(2)
  })

  it('flattens CR, LF and TAB in a plain shell so nothing runs or completes', () => {
    expect(prepareDictationBody('ls\r\nrm -rf x\tdone\n', false)).toBe('ls rm -rf x done ')
  })

  it('drops control bytes in a plain shell too', () => {
    expect(prepareDictationBody('a\x03b\x1bc', false)).toBe('ab<ESC>c')
  })
})

describe('insertRejection', () => {
  it('refuses a pane that waits on a permission prompt', () => {
    expect(insertRejection('blocked')).toBe('target-busy')
  })

  it('accepts working, idle and unknown panes as a draft target', () => {
    for (const s of ['working', 'idle', 'unknown', undefined] as const) {
      expect(insertRejection(s)).toBeNull()
    }
  })
})

describe('shouldSubmitDictation', () => {
  const base = {
    requested: true,
    allowAutoEnter: true,
    bracketed: true,
    agentState: 'idle' as const,
    sameGeneration: true,
    inputStampAtInsert: 100,
    inputStampNow: 100
  }

  it('submits only when everything still matches', () => {
    expect(shouldSubmitDictation(base)).toBe(true)
  })

  it('never submits unless requested and allowed in settings', () => {
    expect(shouldSubmitDictation({ ...base, requested: false })).toBe(false)
    expect(shouldSubmitDictation({ ...base, allowAutoEnter: false })).toBe(false)
  })

  it('never submits in a plain shell', () => {
    expect(shouldSubmitDictation({ ...base, bracketed: false })).toBe(false)
  })

  it('keeps the draft when the agent is busy or blocked', () => {
    expect(shouldSubmitDictation({ ...base, agentState: 'working' })).toBe(false)
    expect(shouldSubmitDictation({ ...base, agentState: 'blocked' })).toBe(false)
  })

  it('keeps the draft after a respawn or any user input since the insert', () => {
    expect(shouldSubmitDictation({ ...base, sameGeneration: false })).toBe(false)
    expect(shouldSubmitDictation({ ...base, inputStampNow: 101 })).toBe(false)
    expect(shouldSubmitDictation({ ...base, inputStampNow: undefined })).toBe(false)
  })
})

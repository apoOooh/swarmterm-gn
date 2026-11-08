import { describe, expect, it } from 'vitest'
import { promptBoxHasDraft } from './prompt-draft'

const RULE = '─'.repeat(40)
const box = (...body: string[]): string =>
  ['● Done. Anything else?', '', RULE, ...body, RULE, '  ctx 42% · mcp ok · 14:03:22', '  ? for shortcuts'].join('\n')

describe('promptBoxHasDraft', () => {
  it('empty prompt box is no draft', () => {
    expect(promptBoxHasDraft(box('> '))).toBe(false)
    expect(promptBoxHasDraft(box('❯'))).toBe(false)
  })

  it('a dim placeholder blanked by the caller is no draft', () => {
    expect(promptBoxHasDraft(box('>                                 '))).toBe(false)
  })

  it('unsent text after the marker is a draft, also on a continuation line', () => {
    expect(promptBoxHasDraft(box('> On shield I see huge performance issues'))).toBe(true)
    expect(promptBoxHasDraft(box('> ', '  second line of a multi-line draft'))).toBe(true)
  })

  it('status line below the box never counts', () => {
    expect(promptBoxHasDraft(box('>'))).toBe(false)
  })

  it('bordered box variant', () => {
    expect(promptBoxHasDraft(box('│ > hello │'))).toBe(true)
    expect(promptBoxHasDraft(box('│ >       │'))).toBe(false)
  })

  it('no box or a non-prompt dialog between rules: no opinion', () => {
    expect(promptBoxHasDraft('$ ls\nfoo bar')).toBe(false)
    expect(promptBoxHasDraft(box('Do you want to proceed?', '1. Yes'))).toBe(false)
  })
})

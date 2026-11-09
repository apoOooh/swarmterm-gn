import { describe, expect, it } from 'vitest'
import { promptBoxDraftText, promptBoxHasDraft, type DraftRow } from './prompt-draft'

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

describe('promptBoxDraftText (SWA-88)', () => {
  const COLS = 80
  const rows = (...body: (string | DraftRow)[]): DraftRow[] =>
    ['● Done.', '', RULE, ...body, RULE, '  ? for shortcuts'].map((r) => (typeof r === 'string' ? { text: r, dim: false } : r))

  it('reads back a one-row draft exactly', () => {
    expect(promptBoxDraftText(rows('> fix the login bug'), COLS)).toBe('fix the login bug')
    expect(promptBoxDraftText(rows('❯ fix   spacing  kept'), COLS)).toBe('fix   spacing  kept')
    expect(promptBoxDraftText(rows('│ > bordered │'), COLS)).toBe('bordered')
  })

  it('gives up on anything it would have to guess', () => {
    // Several rows: an Ink wrap and a typed newline look the same.
    expect(promptBoxDraftText(rows('> first', '  second'), COLS)).toBeUndefined()
    // A DIM cell was blanked: it may have been part of the text.
    expect(promptBoxDraftText(rows({ text: '> text', dim: true }), COLS)).toBeUndefined()
    // Reaches the right edge: may be cut off.
    expect(promptBoxDraftText(rows(`> ${'x'.repeat(COLS - 2)}`), COLS)).toBeUndefined()
    // Empty box, no marker, no box at all.
    expect(promptBoxDraftText(rows('> '), COLS)).toBeUndefined()
    expect(promptBoxDraftText(rows('  Do you want to proceed?'), COLS)).toBeUndefined()
    expect(promptBoxDraftText([{ text: '> loose', dim: false }], COLS)).toBeUndefined()
    // Marker without the space Claude draws after it.
    expect(promptBoxDraftText(rows('>text'), COLS)).toBeUndefined()
  })
})

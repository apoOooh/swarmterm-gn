import { describe, expect, it } from 'vitest'
import { normalizePaneName, parsePaneNumber, resolvePaneAddress, sanitizePaneName, type AddressablePane } from '@/lib/pane-address'

const panes: AddressablePane[] = [
  { terminalId: 't1', number: 1, title: '✳ Claude Code · swarmterm' },
  { terminalId: 't2', number: 2, title: '✳ Claude Code · swarmterm', name: 'Backend' },
  { terminalId: 't3', number: 3, title: 'Codex', name: 'Müller Tests' },
  { terminalId: 't4', number: 4, title: 'Terminal' }
]

describe('parsePaneNumber', () => {
  it('reads digits and German/English number words', () => {
    expect(parsePaneNumber('2')).toBe(2)
    expect(parsePaneNumber(' zwei ')).toBe(2)
    expect(parsePaneNumber('Eins')).toBe(1)
    expect(parsePaneNumber('three')).toBe(3)
    expect(parsePaneNumber('zwölf')).toBe(12)
    expect(parsePaneNumber('Nummer 4')).toBe(4)
    expect(parsePaneNumber('number four')).toBe(4)
  })
  it('rejects anything else', () => {
    expect(parsePaneNumber('0')).toBeNull()
    expect(parsePaneNumber('2a')).toBeNull()
    expect(parsePaneNumber('Backend')).toBeNull()
    expect(parsePaneNumber('')).toBeNull()
  })
})

describe('normalizePaneName', () => {
  it('ignores case, accents, symbols and extra spaces', () => {
    expect(normalizePaneName('  Müller   Tests! ')).toBe('muller tests')
    expect(normalizePaneName('✳ Claude Code · swarmterm')).toBe('claude code swarmterm')
  })
})

describe('resolvePaneAddress', () => {
  it('resolves a number to that pane', () => {
    expect(resolvePaneAddress('drei', panes)).toEqual({ terminalId: 't3' })
    expect(resolvePaneAddress('9', panes)).toEqual({ error: 'no-target' })
  })
  it('refuses a user name that another pane carries as its title', () => {
    const clash: AddressablePane[] = [
      { terminalId: 'a', number: 1, title: 'Codex', name: 'Backend' },
      { terminalId: 'b', number: 2, title: 'Backend' }
    ]
    expect(resolvePaneAddress('Backend', clash)).toEqual({ error: 'ambiguous' })
  })
  it('prefers a user-given name over titles', () => {
    expect(resolvePaneAddress('backend', panes)).toEqual({ terminalId: 't2' })
    expect(resolvePaneAddress('muller tests', panes)).toEqual({ terminalId: 't3' })
  })
  it('falls back to a unique title', () => {
    expect(resolvePaneAddress('codex', panes)).toEqual({ terminalId: 't3' })
    expect(resolvePaneAddress('terminal', panes)).toEqual({ terminalId: 't4' })
  })
  it('never guesses between duplicates', () => {
    expect(resolvePaneAddress('Claude Code swarmterm', panes)).toEqual({ error: 'ambiguous' })
    const twins: AddressablePane[] = [
      { terminalId: 'a', number: 1, title: 'x', name: 'Docs' },
      { terminalId: 'b', number: 2, title: 'y', name: 'docs' }
    ]
    expect(resolvePaneAddress('Docs', twins)).toEqual({ error: 'ambiguous' })
  })
  it('refuses unknown or empty targets', () => {
    expect(resolvePaneAddress('frontend', panes)).toEqual({ error: 'no-target' })
    expect(resolvePaneAddress('  ', panes)).toEqual({ error: 'no-target' })
  })
})

describe('sanitizePaneName', () => {
  it('trims, collapses and caps the name; empty clears it', () => {
    expect(sanitizePaneName('  Back\n end ')).toBe('Back end')
    expect(sanitizePaneName('   ')).toBeUndefined()
    expect(sanitizePaneName('x'.repeat(80))).toHaveLength(40)
  })
  it('refuses a pure number, which would shadow pane numbers', () => {
    expect(sanitizePaneName('3')).toBeUndefined()
    expect(sanitizePaneName('zwei')).toBeUndefined()
  })
})

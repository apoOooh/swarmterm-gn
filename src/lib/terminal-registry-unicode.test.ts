import { describe, it, expect } from 'vitest'
import raw from './terminal-registry.ts?raw'

const src = raw.replace(/^\s*\/\/.*$/gm, '')

// terminal-registry builds a full DOM/WebGL/pty terminal and is not
// constructible in the node test environment, so this guards the wiring at
// source level: the registry must import enableUnicode11 and call it on the
// terminal it creates, after `new Terminal(` and before any output can be
// written to it. Comment lines are stripped first so a commented-out call
// does not satisfy the check.
describe('terminal-registry Unicode 11 wiring', () => {
  it('imports enableUnicode11 from terminal-unicode', () => {
    expect(src).toMatch(/import \{ enableUnicode11 \} from '\.\/terminal-unicode'/)
  })

  it('calls enableUnicode11(term) once, after the Terminal is constructed', () => {
    const calls = src.match(/enableUnicode11\(term\)/g) ?? []
    expect(calls).toHaveLength(1)
    expect(src.indexOf('enableUnicode11(term)')).toBeGreaterThan(src.indexOf('const term = new Terminal('))
  })
})

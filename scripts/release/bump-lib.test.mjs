import { describe, expect, it } from 'vitest'
import { bumpCargoLock, bumpCargoToml, bumpJson, bumpPackageLock } from './bump-lib.mjs'

describe('bumpCargoToml', () => {
  it('rewrites only the [package] version', () => {
    const toml =
      '[package]\nname = "swarmterm"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n'
    const out = bumpCargoToml(toml, '0.2.0')
    expect(out).toContain('version = "0.2.0"')
    expect(out).toContain('serde = { version = "1" }')
  })
})

describe('bumpCargoLock', () => {
  it.each(['\n', '\r\n'])('rewrites only the swarmterm package block with %j endings', (eol) => {
    const lock =
      ['[[package]]', 'name = "serde"', 'version = "1.0.0"', '',
        '[[package]]', 'name = "swarmterm"', 'version = "0.1.0"', ''].join(eol)
    const out = bumpCargoLock(lock, '0.2.0')
    expect(out).toContain(`name = "serde"${eol}version = "1.0.0"`)
    expect(out).toContain(`name = "swarmterm"${eol}version = "0.2.0"`)
  })
})

describe('bumpJson', () => {
  it('rewrites the top-level version preserving 2-space format', () => {
    const out = bumpJson('{\n  "name": "x",\n  "version": "0.1.0"\n}\n', '0.2.0')
    expect(out).toBe('{\n  "name": "x",\n  "version": "0.2.0"\n}\n')
  })
})

describe('bumpPackageLock', () => {
  it('updates both root versions without changing dependency versions', () => {
    const lock = JSON.stringify({
      name: 'swarmterm-gn', version: '1.0.4', lockfileVersion: 3,
      packages: {
        '': { name: 'swarmterm-gn', version: '1.0.4' },
        'node_modules/example': { version: '1.0.4' }
      }
    }, null, 2)
    const updated = JSON.parse(bumpPackageLock(lock, '1.1.0'))
    expect(updated.version).toBe('1.1.0')
    expect(updated.packages[''].version).toBe('1.1.0')
    expect(updated.packages['node_modules/example'].version).toBe('1.0.4')
  })
})

import { describe, expect, it } from 'vitest'
import { assertReleaseVersions } from './versions.mjs'

describe('release version agreement', () => {
  const versions = {
    'package.json': '1.1.0', 'package-lock.json': '1.1.0',
    'package-lock.json packages[""]': '1.1.0', 'tauri.conf.json': '1.1.0',
    'Cargo.toml': '1.1.0', 'Cargo.lock': '1.1.0'
  }

  it('accepts a stable tag matching every manifest', () => {
    expect(assertReleaseVersions('v1.1.0', versions)).toBe('1.1.0')
  })

  it.each(Object.keys(versions))('rejects a stale version in %s', (file) => {
    expect(() => assertReleaseVersions('v1.1.0', { ...versions, [file]: '1.0.4' })).toThrow(file)
  })

  it('rejects a missing manifest version', () => {
    expect(() => assertReleaseVersions('v1.1.0', { ...versions, 'Cargo.lock': undefined })).toThrow('no version')
  })

  it.each(['1.1.0', 'v01.1.0', 'v1.1.0-beta.1', 'v1.1', 'v1.1.0\nextra'])('rejects an invalid tag %s', (tag) => {
    expect(() => assertReleaseVersions(tag, versions)).toThrow('Release tag must')
  })
})

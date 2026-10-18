import { describe, expect, it } from 'vitest'
import { MANIFEST_VERSION, buildWingetManifests, installerUrl, parseSha256Sums } from './winget.mjs'

const base = {
  packageId: 'Example.SwarmtermGN',
  publisher: 'Example Publisher',
  version: '1.18.0',
  repo: 'apoOooh/swarmterm-gn',
  sha256: 'a'.repeat(64)
}

describe('installerUrl', () => {
  it('points at the published asset with the dotted name GitHub uses', () => {
    expect(installerUrl('apoOooh/swarmterm-gn', '1.18.0')).toBe(
      'https://github.com/apoOooh/swarmterm-gn/releases/download/v1.18.0/Swarmterm.GN_1.18.0_x64-setup.exe'
    )
  })
})

describe('parseSha256Sums', () => {
  it('finds the installer hash in sha256sum output, text or binary mode', () => {
    const sums = `${'b'.repeat(64)}  other.exe\n${'C'.repeat(64)} *Swarmterm.GN_1.18.0_x64-setup.exe\n`
    expect(parseSha256Sums(sums, 'Swarmterm.GN_1.18.0_x64-setup.exe')).toBe('c'.repeat(64))
  })

  it('returns null when the asset is missing', () => {
    expect(parseSha256Sums(`${'b'.repeat(64)}  other.exe\n`, 'x.exe')).toBeNull()
  })
})

describe('buildWingetManifests', () => {
  const files = buildWingetManifests(base)

  it('emits the three multi-file manifests named after the identifier', () => {
    expect(Object.keys(files).sort()).toEqual([
      'Example.SwarmtermGN.installer.yaml',
      'Example.SwarmtermGN.locale.en-US.yaml',
      'Example.SwarmtermGN.yaml'
    ])
    for (const yaml of Object.values(files)) {
      expect(yaml).toContain(`PackageIdentifier: Example.SwarmtermGN`)
      expect(yaml).toContain(`PackageVersion: 1.18.0`)
      expect(yaml).toContain(`ManifestVersion: ${MANIFEST_VERSION}`)
    }
  })

  it('describes the Tauri NSIS installer as a per-user nullsoft install', () => {
    const inst = files['Example.SwarmtermGN.installer.yaml']
    expect(inst).toContain('InstallerType: nullsoft')
    expect(inst).toContain('Scope: user')
    expect(inst).toContain('Architecture: x64')
    expect(inst).toContain(`InstallerUrl: ${installerUrl(base.repo, base.version)}`)
    expect(inst).toContain(`InstallerSha256: ${'A'.repeat(64)}`)
    expect(inst).toContain('ManifestType: installer')
  })

  it('carries publisher, license and links in the default locale', () => {
    const loc = files['Example.SwarmtermGN.locale.en-US.yaml']
    expect(loc).toContain(`Publisher: "Example Publisher"`)
    expect(loc).toContain('License: GPL-3.0-only')
    expect(loc).toContain('PackageUrl: https://github.com/apoOooh/swarmterm-gn')
    expect(loc).toContain('ReleaseNotesUrl: https://github.com/apoOooh/swarmterm-gn/releases/tag/v1.18.0')
    expect(loc).toContain('ManifestType: defaultLocale')
  })

  it('refuses incomplete or unsafe input instead of emitting a broken manifest', () => {
    expect(() => buildWingetManifests({ ...base, packageId: 'NoDot' })).toThrow(/packageId/)
    expect(() => buildWingetManifests({ ...base, version: 'v1.18.0' })).toThrow(/version/)
    expect(() => buildWingetManifests({ ...base, sha256: 'xyz' })).toThrow(/sha256/)
    expect(() => buildWingetManifests({ ...base, publisher: '' })).toThrow(/publisher/)
    expect(() => buildWingetManifests({ ...base, publisher: 'a\nb' })).toThrow(/publisher/)
  })
})

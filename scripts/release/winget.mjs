// winget manifest template for Swarmterm GN (SWA-43). Pure builder plus a
// thin CLI, so the first manual submission and the release workflow's komac
// step describe the same installer.
//
// Why these values: Tauri's NSIS bundle installs per user by default
// (`Scope: user`, no UAC prompt) and takes the standard NSIS silent switch,
// so `InstallerType: nullsoft` needs no custom switches. The URL is the
// PUBLISHED asset name: GitHub turns the space in "Swarmterm GN_…" into a dot
// (see release.yml), and draft-release URLs die when the release goes public.
//
// Nothing here submits anything. Identifier and publisher name are public
// once a manifest reaches microsoft/winget-pkgs, so both are inputs, never
// defaults.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST_VERSION = '1.10.0'
const SCHEMA = `https://aka.ms/winget-manifest`

export const installerName = (version) => `Swarmterm.GN_${version}_x64-setup.exe`

export const installerUrl = (repo, version) =>
  `https://github.com/${repo}/releases/download/v${version}/${installerName(version)}`

/** Hash of `name` from `sha256sum` output (text or `*binary` mode), lowercase. */
export function parseSha256Sums(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim())
    if (m && m[2] === name) return m[1].toLowerCase()
  }
  return null
}

function check(input) {
  const { packageId, publisher, version, repo, sha256 } = input
  // winget identifiers are Publisher.Package segments without spaces.
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(packageId ?? '')) {
    throw new Error(`packageId must look like Publisher.Package, got ${JSON.stringify(packageId)}`)
  }
  if (!publisher || /[\r\n]/.test(publisher)) {
    throw new Error('publisher must be a non-empty single line')
  }
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`version must be X.Y.Z without a leading v, got ${JSON.stringify(version)}`)
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo ?? '')) throw new Error('repo must be owner/name')
  if (!/^[0-9a-fA-F]{64}$/.test(sha256 ?? '')) throw new Error('sha256 must be 64 hex digits')
}

/**
 * @param {object} input
 * @param {string} input.packageId  e.g. "Publisher.SwarmtermGN" (user decision)
 * @param {string} input.publisher  public publisher name (user decision)
 * @param {string} input.version    "X.Y.Z"
 * @param {string} input.repo       "owner/name"
 * @param {string} input.sha256     installer hash
 * @returns {Record<string, string>} file name → YAML, the multi-file layout
 *   winget-pkgs expects under manifests/<letter>/<Publisher>/<Package>/<version>/
 */
export function buildWingetManifests(input) {
  check(input)
  const { packageId, publisher, version, repo } = input
  const head = (type) =>
    [
      `# yaml-language-server: $schema=${SCHEMA}.${type}.${MANIFEST_VERSION}.schema.json`,
      `PackageIdentifier: ${packageId}`,
      `PackageVersion: ${version}`
    ].join('\n')
  const tail = (type) => `ManifestType: ${type}\nManifestVersion: ${MANIFEST_VERSION}\n`
  const home = `https://github.com/${repo}`

  return {
    [`${packageId}.yaml`]: [head('version'), 'DefaultLocale: en-US', tail('version')].join('\n'),
    [`${packageId}.installer.yaml`]: [
      head('installer'),
      'InstallerType: nullsoft',
      'Scope: user',
      'UpgradeBehavior: install',
      'Installers:',
      '  - Architecture: x64',
      `    InstallerUrl: ${installerUrl(repo, version)}`,
      `    InstallerSha256: ${input.sha256.toUpperCase()}`,
      tail('installer')
    ].join('\n'),
    [`${packageId}.locale.en-US.yaml`]: [
      head('defaultLocale'),
      'PackageLocale: en-US',
      // JSON strings are valid YAML double-quoted scalars, so any publisher
      // name (colons, quotes, non-ASCII) stays one safe scalar.
      `Publisher: ${JSON.stringify(publisher)}`,
      'PackageName: Swarmterm GN',
      `PackageUrl: ${home}`,
      'License: GPL-3.0-only',
      `LicenseUrl: ${home}/blob/main/LICENSE`,
      'ShortDescription: One window for a swarm of AI coding agents - split terminals, git worktrees, live previews and a War Room.',
      'Tags:',
      '  - terminal',
      '  - ai',
      '  - agents',
      '  - claude-code',
      '  - codex',
      `ReleaseNotesUrl: ${home}/releases/tag/v${version}`,
      tail('defaultLocale')
    ].join('\n')
  }
}

// CLI: node scripts/release/winget.mjs --id <Id> --publisher <Name>
//        --version X.Y.Z --sums SHA256SUMS.txt --out <dir> [--repo owner/name]
// Writes the three manifests for a manual first submission (`komac new` /
// `wingetcreate submit <dir>`); later releases go through komac in CI.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
  )
  const version = args.version
  const sha256 = parseSha256Sums(readFileSync(args.sums ?? '', 'utf8'), installerName(version))
  if (!sha256) {
    console.error(`no hash for ${installerName(version)} in ${args.sums}`)
    process.exit(1)
  }
  const files = buildWingetManifests({
    packageId: args.id,
    publisher: args.publisher,
    version,
    repo: args.repo ?? 'apoOooh/swarmterm-gn',
    sha256
  })
  mkdirSync(args.out, { recursive: true })
  for (const [name, yaml] of Object.entries(files)) writeFileSync(join(args.out, name), yaml)
  console.log(`wrote ${Object.keys(files).length} manifests to ${args.out}`)
}

// Bumps the version everywhere it is duplicated, then verifies agreement.
// Usage: npm run bump -- 0.2.0
import { readFileSync, writeFileSync } from 'node:fs'
import { bumpCargoLock, bumpCargoToml, bumpJson, bumpPackageLock } from './release/bump-lib.mjs'
import { assertReleaseVersions, readReleaseVersions } from './release/versions.mjs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: npm run bump -- <x.y.z>')
  process.exit(1)
}

const edits = [
  ['package.json', bumpJson],
  ['package-lock.json', bumpPackageLock],
  ['src-tauri/tauri.conf.json', bumpJson],
  ['src-tauri/Cargo.toml', bumpCargoToml],
  ['src-tauri/Cargo.lock', bumpCargoLock]
]
for (const [file, fn] of edits) writeFileSync(file, fn(readFileSync(file, 'utf8'), version))

// Trust nothing: re-read and assert every copy agrees before the tag is cut.
try {
  assertReleaseVersions(`v${version}`, readReleaseVersions())
} catch (error) {
  console.error(`bump: ${error.message}`)
  process.exit(1)
}
console.log(`bump: all five files at ${version} — next: git commit, git tag v${version}`)

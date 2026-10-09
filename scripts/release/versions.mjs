import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readReleaseVersions(root = process.cwd()) {
  const read = (file) => readFileSync(join(root, file), 'utf8')
  const lock = JSON.parse(read('package-lock.json'))
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    'tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
    'Cargo.toml': read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    'Cargo.lock': read('src-tauri/Cargo.lock').match(/name = "swarmterm"\r?\nversion = "([^"]+)"/)?.[1]
  }
}

export function assertReleaseVersions(tag, versions) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Release tag must be v<major>.<minor>.<patch>, for example v1.1.0')
  }
  const version = tag.slice(1)
  for (const [file, actual] of Object.entries(versions)) {
    if (actual !== version) throw new Error(`${file}: expected ${version}, found ${actual ?? 'no version'}`)
  }
  return version
}

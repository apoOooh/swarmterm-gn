import { appendFileSync } from 'node:fs'
import { assertReleaseVersions, readReleaseVersions } from './versions.mjs'

try {
  const tag = process.argv[2]
  const version = assertReleaseVersions(tag, readReleaseVersions())
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${version}\n`)
  }
  console.log(`release: ${tag} matches all manifests and lockfiles`)
} catch (error) {
  console.error(`release: ${error.message}`)
  process.exit(1)
}

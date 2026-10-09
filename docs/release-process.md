# Releasing Swarmterm GN for Windows

Swarmterm GN supports **Windows x64**. The fork's
[Windows release workflow](../.github/workflows/release.yml) builds an NSIS
installer and publishes it on GitHub Releases when a `v<major>.<minor>.<patch>`
tag is pushed. macOS and Linux packages are not published or supported.

## Create a release

Start from the tested `dev` integration branch. Keep release preparation on a
topic branch, merge it into `dev`, and push before creating the tag.

```powershell
npm run bump -- 1.1.0
# Write docs/releases/1.1.0.md and update CHANGELOG.md.
# Commit the version files, notes and workflow changes; merge into dev.
git push origin dev
git tag -a v1.1.0 -m "Swarmterm GN 1.1.0: first Windows release"
git push origin v1.1.0
```

Use a new version for each release. `npm run bump` updates the npm manifest,
npm lockfile, Tauri configuration, Rust manifest and Rust lockfile together.
The workflow rejects a tag whose version disagrees with any of them, a tag
outside `dev` history, or a version without `docs/releases/<version>.md`.
Existing upstream tags are retained; the first GN release is `v1.1.0`.

## What the workflow does

1. Verify the existing tag, version agreement and release notes.
2. Run the reusable CI workflow: frontend types, unit tests, production build,
   headless browser tests, full-history secret scan and Windows Rust checks.
3. Build the Windows x64 NSIS installer with locked Rust dependencies.
4. Download the build artifact in a separate publishing job and add
   `SHA256SUMS.txt`.
5. Create a draft, upload both files, then publish the release only after all
   checks and the installer build succeed.

The installer remains available as a workflow artifact for 14 days even if
publication fails. A failed upload leaves a draft rather than a public,
incomplete release. Rerun failed jobs or use **Actions → Windows release →
Run workflow** with an existing tag to retry. The workflow refuses to replace
assets of an already published release. Tags must not be moved or overwritten.

Only the final publishing job receives repository write permission. No
additional repository secrets are required. The workflow is restricted to
`apoOooh/swarmterm-gn`; other forks can explicitly adapt that condition.

## Signing and updates

The first installer is **not Authenticode-signed**. Windows SmartScreen may
show an unknown publisher warning. This is stated in each release's notes.
The release supplies SHA-256 checksums alongside the installer.

Upstream automatic updates remain disabled, and this workflow does not upload
`latest.json` or updater signatures. The old `release:publish` helper requires
a configured fork-owned updater and deliberately refuses the current GN
configuration. GitHub Releases is the supported download path.

For a local installer build, see [release-windows.md](release-windows.md).
Native clipboard, tray and codec checks remain in
[manual-smoke-tests.md](manual-smoke-tests.md); a headless build does not claim
those desktop interactions were manually tested.

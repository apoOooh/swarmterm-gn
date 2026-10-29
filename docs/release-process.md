# Releasing Swarmterm GN for Windows

Swarmterm GN supports **Windows x64**. The fork's
[Windows release workflow](../.github/workflows/release.yml) builds an NSIS
installer and publishes it on GitHub Releases when a `v<major>.<minor>.<patch>`
tag is pushed. macOS and Linux packages are not published or supported.

## Create a release

Releases are cut from **`main`**. Branches:

- `dev` is the integration branch. Feature and fix branches merge into it.
- `main` holds only released states. It changes only by merging `dev` for a
  release, and each release tag sits on that merge commit.

Steps, starting from a tested `dev`:

1. Prepare the release on a topic branch (`chore/release-<version>`): bump the
   version, write the notes, update the changelog. Merge it into `dev` and
   push `dev`.
2. Merge `dev` into `main` with a merge commit titled `Release GN <version>`,
   and push `main`.
3. Tag that merge commit on `main` and push the tag. The tag starts the
   workflow.

```powershell
npm run bump -- 1.20.0
# Write docs/releases/1.20.0.md and update CHANGELOG.md.
# Commit them on chore/release-1.20.0, then:
git switch dev
git merge --no-ff chore/release-1.20.0
git push origin dev
git switch main
git pull --ff-only origin main
git merge --no-ff dev -m "Release GN 1.20.0"
git push origin main
git tag -a v1.20.0 -m "Swarmterm GN 1.20.0: <summary>"
git push origin v1.20.0
git switch dev
```

Never tag on `dev`, and never commit to `main` directly. Fixes go to `dev`
first and reach `main` with the next release.

Use a new version for each release. `npm run bump` updates the npm manifest,
npm lockfile, Tauri configuration, Rust manifest and Rust lockfile together.
The workflow rejects a tag whose version disagrees with any of them, a tag
outside `main` history, or a version without `docs/releases/<version>.md`.
Through 1.19.0, tags were on `dev` and `main` was merged afterwards. Those
tags are on `main`'s history once that merge is pushed, so re-running the
workflow for them still passes; before it, a retry fails the `main` check.
Tags inherited from before the fork are retained; the first GN release is `v1.1.0`.

## What the workflow does

1. Verify the existing tag, version agreement and release notes.
2. Run the reusable CI workflow: frontend types, unit tests, production build,
   headless browser tests, full-history secret scan, Windows Rust checks and
   the dependency audit (`cargo deny`, `npm audit`).
3. Build both Windows x64 NSIS installers with locked Rust dependencies, in
   parallel: **Swarmterm GN** and **Swarmterm GN Corp**
   (`--config src-tauri/tauri.corp.conf.json -- --features corp`, see
   [editions.md](editions.md)). Each exe is checked for analytics endpoints;
   the Corp exe also for the buzzkey and speech-model download endpoints.
4. Download both build artifacts in a separate publishing job, generate the
   CycloneDX SBOMs `sbom-rust.cdx.json`, `sbom-rust-host.cdx.json` and
   `sbom-npm.cdx.json` (they cover both editions; `corp` adds no
   dependencies), rename the installers to
   `Swarmterm.GN_<version>_x64-setup.exe` and
   `Swarmterm.GN.Corp_<version>_x64-setup.exe`, and add
   `SHA256SUMS.txt` over all assets.
5. Create signed build provenance (`actions/attest-build-provenance`, Sigstore)
   for every installer, SBOM and `SHA256SUMS.txt`; it is stored in the
   repository's attestations and checked with `gh attestation verify`.
6. Create a draft, upload all files, then publish the release only after all
   checks and the installer build succeed.
7. Optional: submit the new version to winget (see below). This step is
   skipped without the opt-in secret and variable.

The installer remains available as a workflow artifact for 14 days even if
publication fails. A failed upload leaves a draft rather than a public,
incomplete release. Rerun failed jobs or use **Actions → Windows release →
Run workflow** with an existing tag to retry. The workflow refuses to replace
assets of an already published release. Tags must not be moved or overwritten.

Every workflow starts with no token permissions (`permissions: {}`); jobs ask
for what they need. Only the final publishing job receives repository write
permission, plus `id-token` and `attestations` for the provenance.
Third-party actions are pinned to full commit SHAs (Dependabot proposes
updates), and the Rust toolchain comes from `rust-toolchain.toml`. No
additional repository secrets are required. The workflow is restricted to
`apoOooh/swarmterm-gn`; other forks can explicitly adapt that condition.

## winget (optional)

Swarmterm GN is not in winget yet. The first submission is a manual,
public step taken by the maintainer, who also chooses the package identifier
and the publisher name. Nothing in this repository submits on its own.

1. Generate the manifests for a published release:

   ```bash
   gh release download v<version> --pattern SHA256SUMS.txt --dir winget-tmp
   node scripts/release/winget.mjs --id <Publisher.SwarmtermGN> \
     --publisher "<Publisher name>" --version <version> \
     --sums winget-tmp/SHA256SUMS.txt --out winget-tmp/manifests
   ```

   They describe the Standard edition's per-user NSIS installer
   (`InstallerType: nullsoft`, `Scope: user`); a Corp manifest would need
   `Scope: machine`. Validate with `winget validate winget-tmp/manifests`,
   test with `winget install --manifest winget-tmp/manifests`, then submit
   (for example with `komac new` or `wingetcreate submit`).
2. Once the package is accepted, enable automatic updates: fork
   `microsoft/winget-pkgs` into the account that owns the token, add a
   classic personal access token with `public_repo` as the repository
   secret `WINGET_TOKEN`, and add the identifier as the repository variable
   `WINGET_PACKAGE_ID`.

The `winget` job in the release workflow then runs `komac update --submit`
after each published release. komac is pinned by version and archive hash.
Without the secret or the variable, the job logs that it skipped and the
release stays green. Each release opens a pull request in
`microsoft/winget-pkgs` that Microsoft reviews; unsigned installers may be
held for manual validation.

## Signing and updates

The first installer is **not Authenticode-signed**. Windows SmartScreen may
show an unknown publisher warning. This is stated in each release's notes.
The release supplies SHA-256 checksums, CycloneDX SBOMs and signed build
provenance alongside the installer; users verify downloads as described in
[enterprise-deployment.md](enterprise-deployment.md#verify-a-download).

## Release notes template

Every `docs/releases/<version>.md` ends with this download section:

```markdown
## Download

Install the **Windows x64 setup executable** attached to this release. The
Microsoft WebView2 Runtime is required.

Verify the download in PowerShell before installing:

    Get-FileHash -Algorithm SHA256 .\Swarmterm.GN_<version>_x64-setup.exe
    # must match the line in SHA256SUMS.txt
    gh attestation verify .\Swarmterm.GN_<version>_x64-setup.exe --repo apoOooh/swarmterm-gn
    # proves it was built by this repository's release workflow

The installer is not Authenticode-signed; Windows SmartScreen may show an
unknown publisher warning. The app never updates itself. Download future
GN versions from this fork's releases. macOS and Linux are not supported.
```

The app never updates itself and contains no updater; this workflow uploads no
`latest.json` or updater signatures. New versions reach users as installers
from GitHub Releases (or IT software distribution).

For a local installer build, see [release-windows.md](release-windows.md).
Native clipboard, tray and codec checks remain in
[manual-smoke-tests.md](manual-smoke-tests.md); a headless build does not claim
those desktop interactions were manually tested.

# Building Swarmterm GN for Windows locally

Swarmterm GN ships as an NSIS installer (`Swarmterm GN_<version>_x64-setup.exe`).
Official fork releases are built by the [Windows release workflow](release-process.md).
This page describes an optional local build. The build is **unsigned** —
see the SmartScreen section for what users see and why that is acceptable for
now. The app never updates itself, so no updater signing key is needed.

The overall flow (bump → tag → build → publish) lives in
[release-process.md](release-process.md).

## One-time setup

1. **Rust (MSVC):** install from https://rustup.rs — accept the default
   `x86_64-pc-windows-msvc` toolchain.
2. **Visual Studio Build Tools** with the *Desktop development with C++*
   workload (the linker and Windows SDK Tauri needs).
3. **Node 24** and `npm`.
4. Clone `apoOooh/swarmterm-gn` and run `npm ci`. Check out `main` or a release
   tag to build released code; `dev` has unreleased changes.

## Releasing

```powershell
npm run release:win        # standalone NSIS installer, with assertions
```

The build script asserts that the installer exists and carries the version
from `tauri.conf.json`. Output lands in
`src-tauri\target\release\bundle\nsis\`.

To sanity-check the installer locally: run it (Standard: per-user install, no admin
prompt; Corp: per-machine install with a UAC prompt), launch Swarmterm, then uninstall via Settings → Apps.

## SmartScreen: what unsigned means

Windows does not block unsigned apps — it warns. A user downloading the
installer sees **"Windows protected your PC"** with the publisher listed as
*Unknown*. The path through is **More info → Run anyway**; the browser may
add its own "keep file?" step before that.

Put a line like this in every release's notes:

> Windows: the installer is not code-signed yet. SmartScreen will warn —
> click **More info**, then **Run anyway**.

Buying an Authenticode certificate later slots into `release-windows.ps1` as
an extra signing step and changes nothing else in the pipeline. The app never
updates itself, so every new version is an installer that users (or IT
software distribution) run.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `link.exe not found` / C++ toolchain errors | VS Build Tools missing the C++ workload | re-run the Build Tools installer, add *Desktop development with C++* |
| installer runs but app won't start | WebView2 missing (rare — NSIS bundles the bootstrapper) | install the WebView2 Evergreen runtime from Microsoft |

# Project decisions

Decisions made by the maintainer that every contributor follows. Newest
first. Architecture decisions with longer reasoning live in [adr/](adr/).

## 2026-10-29

- **Administrator policy keys.** Organisations lock features through
  `HKLM\Software\Policies\SwarmtermGN` (and HKCU; HKLM wins per value), read
  once at start: `DisableBypassModes`, `DisableWarRoomExecute`,
  `DisableWorktreeSpawn`, `DisableMcp`, `DisableCompanion`,
  `DisableModelDownload`, `DisableRoutineCommands`, `DisablePreviewBrowser`
  (REG_DWORD 1), `EnvPolicy` (`default`|`strict`, forces the filter on and
  drops the user's allow list) and `EnvAllow` (REG_MULTI_SZ). Every lock is
  enforced in Rust at the point of action, never UI-only; unknown or invalid
  values are ignored and logged. A later `corp` build reuses the same layer
  with compiled-in locks. See [admin-policy.md](admin-policy.md).
- **The user decides whether spawned workers inherit Bypass/YOLO.** Settings →
  Terminal → Agent safety, default off (workers start in a confirming mode).
  On: a `worktree.spawn` worker of the same agent inherits the requester's
  bypass mode, still badged red. `DisableBypassModes` forces it off.

- **Independent project.** Swarmterm GN started as a fork of
  [duongducnguyen/swarmterm](https://github.com/duongducnguyen/swarmterm) and
  is now its own project. It is not based on or synced with upstream; upstream's
  website, policies and releases do not apply. Do not merge from upstream as a
  routine; port individual changes deliberately if ever needed.
- **No telemetry.** The application sends no telemetry, analytics or usage
  data. The release workflow fails if an analytics endpoint appears in the
  executable.
- **No self-update.** No updater plugin, no update checks for the app itself.
  New versions are installers from GitHub Releases or IT software
  distribution.
- **Privacy and terms live in the repository.** There is no project website.
  [PRIVACY.md](../PRIVACY.md), [TERMS.md](../TERMS.md) and
  [SECURITY.md](../SECURITY.md) are the authoritative documents and must be
  updated in the same change as any behaviour they describe (new network
  connection, new stored data).
- **Secrets are not passed to panes by default.** Panes and command routines
  get the application environment without secret-looking variables
  (Settings → Terminal → Environment); passing them is an explicit opt-in.
- **Media thumbnails auto-load** (since 1.25.4). Images detected in pane output
  show their thumbnail in the Media strip without a click; the panel never
  opens by itself.
- **Supply chain checks.** CI runs `cargo deny` and `npm audit`; every release
  ships CycloneDX SBOMs with checksums. Licence or advisory exceptions need a
  written reason in `src-tauri/deny.toml`.
- **README covers all features.** The README is a short, scannable
  GitHub-style overview: features list, install, quick start, security and
  privacy, build, origin, licence. Details stay in the user guide.
- **Enforcement for organisations.** Administrator policy through the
  registry (see the 2026-10-29 entry above); a `corp` build variant with
  restricted defaults is planned.
- **Direct merges, no pull requests.** Feature branches are merged into `dev`
  locally and `dev` is pushed directly; releases merge `dev` into `main` the
  same way (`docs/release-process.md`). Branch rulesets therefore only block
  deletion and force-push, and do not require pull requests or status checks.

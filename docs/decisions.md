# Project decisions

Decisions made by the maintainer that every contributor follows. Newest
first. Architecture decisions with longer reasoning live in [adr/](adr/).

## 2026-11-11

- **Status line templates (SWA-92).** The Claude status line offers
  Compact, Extended and Detailed (the maintainer's own line as reference),
  plus Off. Schemes Subtle, App theme and High contrast; vibrance only on
  App theme, never fading warnings. Animation limited to Off / a subtle
  spinner (no blinking or pulsing). The line wraps by segment to `COLUMNS`.
  Codex gets the same three templates as `tui.status_line` item lists from
  a per-version whitelist; Swarmterm keeps the previous values and never
  overwrites a list the user changed. Own Settings category; the setup
  assistant shows only the templates. Agreed with Codex in the War Room
  (2026-11-09).
- **Hook-reported media is stamped like printed media** (lead decision).
  `media:detected` carries the file's `mtimeMs` and `size` from the same
  existence check, so a Read/Write of a file overwritten in place refreshes
  the gallery entry and is announced again, exactly like a reprinted path,
  while an unchanged one stays silent. Screen and hook share one per-pane
  record, so the same version is never announced twice. Both values are file
  metadata of a path that is already sent; no content crosses the port.
  Accepted gap: an entry the user opened or pasted (no stamp yet) adopts the
  first detected stamp silently, so an overwrite before any detection of it
  is not announced. A version with an older mtime never replaces a newer
  recorded one (a late lookup must not roll back an overwrite), so a file
  replaced by a copy that keeps an older mtime (Explorer copy, `Copy-Item`,
  `cp -p`, restore from backup) or after the
  clock went backwards is not refreshed until a newer mtime appears. Agent
  screenshot overwrites write fresh files, so their mtime moves forward.
- **Agent media detection uses the Claude hook; the hook forwards media
  paths and cwd, never content.** Passive media detection missed most images
  agents and their subagents open (collapsed tool lines, subagent calls that
  never reach the screen, wrapped long paths, relative names after a `cd`).
  So the `swarmterm --hook` contract is widened: on `PostToolUse` of `Read`
  or `Write` it forwards the tool input's `file_path` when that is an
  absolute local path (at most 1024 characters) with an image/video
  extension, and on every `PostToolUse` the agent's current `cwd` (absolute,
  same bound). Nothing else from the tool input or response is read into a
  struct; file content never crosses the loopback port. The app checks the
  path like a printed one (existing media file, not allow-listed) and keeps
  the cwd in memory per pane only, to resolve relative names printed on
  screen when the pane's start folder has no such file. Screen detection
  also joins absolute paths Claude Code hard-wraps at the pane edge.
- **A nested agent session in the same pane also counts for media** (lead
  decision). A `claude` started inside a pane inherits the pane's bearer, so
  its hook posts reach `/hook` as that pane: its media path is detected and
  its cwd updates the pane's agent cwd, although its status signals may be
  ignored (Codex panes). Rationale: the file must still exist, is checked by
  kind, is never allow-listed or opened without a click, and the nested
  agent's images are wanted in the pane's Media gallery.

## 2026-11-09

- **Local hang diagnostics; dumps are opt-in.** After the installed app was
  reported "not responding" twice (SWA-85), Swarmterm records UI stalls
  locally. The stall log (`diagnostics\ui-stalls.log`: time and duration of a
  stall of 2 s or more, no content) is always on. A minidump per stall is
  opt-in (Settings → Terminal → Diagnostics, off by default), written by a
  separate process, kept on the machine and never uploaded. The admin policy
  `DisableHangDumps` locks it, and the Corp edition has it locked (built
  in), because a dump can hold terminal text from memory. The no-telemetry
  decision of 2026-10-29 is unchanged: nothing is sent.
- **Media without range requests is limited to 32 MB** (SWA-85). The webview
  copies a whole-file answer on the UI thread, so the window stalls in
  proportion to the size (250 MB measured 0.6 s). Larger images show *Open in
  default app* instead of the in-app viewer; videos stream in ranges and are
  unaffected.
- **No installation from inside the app.** First-run setup (SWA-83) explains
  a missing prerequisite or agent CLI and shows the vendor link and the
  install command to copy. Swarmterm never installs anything itself and never
  types an install command into a pane, not even one that waits for Enter.
- **Agent config only for installed CLIs.** Swarmterm writes hooks, MCP
  entries and the status line only for an agent CLI it finds, or into a
  profile that already holds Swarmterm entries (to keep repairing them).
  Outcomes are shown in Settings → Setup; only a real failure reaches the
  bell.
- **Blocked prompts come back masked, automatically** (user decision,
  SWA-88). When data-shield's guard blocks a Claude Code prompt, it reports
  the masked version to `POST /resubmit`; Swarmterm clears the restored
  plaintext from the input box (Esc Esc, never Ctrl+C), puts the masked
  prompt there and sends it — nothing interactive. "Put back only" and "off"
  stay selectable in Settings → Terminal → Agent safety. A key typed in the
  pane since the Enter wins: nothing is replaced, the pane offers the masked
  prompt to copy. Corp puts it back but never sends it
  (`DisablePromptResubmitSend` built in); `DisablePromptResubmit` turns it
  off. The self-injection safeguards stay (bound to the prompt edge and the
  blocked prompt's fingerprint, once, 10 s, refused after a tool call, a
  mask placeholder required); only where it cannot be done safely
  automatically does the pane fall back to a copy button; the
  remaining risk is described in `security-model.md`.
- **Automatic send stays the default despite the self-injection risk**
  (user decision 2026-11-09, SWA-88 review). A review showed that a process
  inside the pane can fake a block (its own prompt edge with a chosen
  fingerprint, then `/resubmit`), so the route is no trust boundary. The
  user kept "put back and send" as the default everywhere; instead the
  renderer was hardened: the resubmit needs a real Enter of the user in that
  pane seen by the renderer (≤ 15 s, once — the anchor) and a visible
  restored draft; a draft that reads back exactly (one row) must also match
  the fingerprint, while multi-row, wrapped and "[Pasted text …]" drafts are
  resubmitted without that comparison (user decision 2026-11-09), re-checks of typing, IME, setting and
  pane before every Esc/insert/Enter, and at most one attempt with Enter per
  pane every 30 s; fingerprints expire on a timer after 10 s. The remaining
  risk is documented in `security-model.md`; `DisablePromptResubmitSend` /
  `DisablePromptResubmit` and the setting stay the way to switch it off.

## 2026-10-29

- **Claude Code "Auto" counts as a dangerous launch mode.** Auto turns the
  per-action prompts off and lets Claude's own classifier approve, so it is
  treated like Bypass/YOLO: confirmation dialog, red badge, not inherited by
  `worktree.spawn` workers unless the user setting allows it, and blocked by
  `DisableBypassModes` (always on in the Corp edition), in Rust too. The
  backend launch-line check is a guard against mistakes, not a sandbox.
- **`DisableWarRoom` policy; Corp does not lock it.** A new REG_DWORD
  `DisableWarRoom` turns the whole War Room off (joins, the user's sends and
  every `war_room.*` MCP tool are refused in Rust). The Corp edition does not
  compile it in: Corp already blocks `execute`, and probes plus `read_peer`
  are core workflow there, so the War Room stays lockable by policy only.
- **MCP bearer token is a per-pane secret, not the pane id.** `war_room.list_peers`
  shows pane ids, so `SWARMTERM_SESSION` is now a random secret minted per
  spawn (rotated on respawn) and mapped to the pane id in the backend; every
  writer keeps referencing the variable, so no config migration is needed.
  Panes reattached from the terminal host that an older build created keep
  their id as bearer until their next respawn.

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
- **Supply-chain hardening (P10, 2026-10-29).** Workflow actions pinned to
  commit SHAs (Dependabot bumps them), `permissions: {}` at workflow level,
  Rust toolchain pinned in `rust-toolchain.toml`, `--locked` cargo, npm
  installs with `--ignore-scripts` (only esbuild rebuilt) and
  `npm audit signatures`, CodeQL and OpenSSF Scorecard, signed build
  provenance for every release asset, REUSE compliance (`REUSE.toml`,
  `LICENSES/`). No installer code signing and no OpenSSF Best Practices
  badge (user, 2026-10-29). Rust third-party notices come from the release
  SBOMs, not a generated `cargo about` file: one source, nothing to keep in
  sync. Admin-only GitHub settings live in `docs/maintainer-todos.md`.
- **Release CSP (2026-10-29).** The release CSP drops the dev-server entry
  (`ws://localhost:1420`, now `devCsp` only) and plain `http:` images;
  Markdown previews still load remote `https:` images (a preview feature,
  listed in PRIVACY.md). `freezePrototype` stays off until it is tested
  against xterm.js, CodeMirror and the other renderer libraries.
- **README covers all features.** The README is a short, scannable
  GitHub-style overview: features list, install, quick start, security and
  privacy, build, origin, licence. Details stay in the user guide.
- **Enforcement for organisations.** Administrator policy through the
  registry (see the 2026-10-29 entry above) plus a separate Corp edition.
- **Corp edition contents** (user decision 2026-10-29, contents chosen by the
  maintainer). Swarmterm GN Corp compiles in `DisableBypassModes`,
  `DisableWarRoomExecute`, `DisableCompanion`, `DisableModelDownload` and
  `EnvPolicy=default`, and compiles the buzzkey installer/updater and the
  speech model download out. Command routines, `worktree.spawn`, the web
  preview and MCP stay available and policy-lockable: they are core workflow,
  run only what the user starts and fetch no code. The registry policy applies
  on top and can only add locks. Both editions' differences are documented in
  `docs/editions.md` (user requirement: describe the versions clearly).
- **Corp identity** (2026-10-29). Corp has its own identifier
  `com.apooooh.swarmterm.gn.corp` and product name "Swarmterm GN Corp"
  (`src-tauri/tauri.corp.conf.json`), so both editions install side by side
  with separate settings and single-instance locks, a Standard install's
  settings cannot reach a Corp one, and IT can tell them apart in software
  inventory. Settings are not migrated. Every release publishes both
  installers.
- **Corp installs per machine** (lead decision 2026-10-29). The Corp
  installer uses NSIS `installMode: "perMachine"`
  (`src-tauri/tauri.corp.conf.json`): it needs administrator rights and
  installs to `%ProgramFiles%\Swarmterm GN Corp\`, which users cannot write,
  so a user cannot swap the executable. The Standard installer stays per user.
  Settings and data stay per user in both editions.
- **Direct merges, no pull requests.** Feature branches are merged into `dev`
  locally and `dev` is pushed directly; releases merge `dev` into `main` the
  same way (`docs/release-process.md`). Branch rulesets therefore only block
  deletion and force-push, and do not require pull requests or status checks.
- **Debug builds start in the background** (user decision 2026-11-09,
  SWA-84). Scripts, the testlab and agents in panes start debug builds while
  the user works elsewhere, so a debug build shows its main window without
  focus and at the bottom of the z-order (`HWND_BOTTOM`, behind every window,
  only on the first reveal). `SWARMTERM_DEV_HIDDEN=1` keeps it hidden for
  unattended runs driven over CDP. Release builds never read the variable
  and keep showing the window in front. Tray "Show" and a second launch
  still bring the window forward in every build.

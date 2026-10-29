# Changelog

## [Unreleased]

## [1.26.0] - 2026-10-29

Corporate readiness release: no telemetry, no updater, secrets withheld from
child processes, hardened agent permissions, an administrator policy, a
second **Swarmterm GN Corp** installer and a verifiable supply chain. Read
**Changed** and **Removed** before upgrading: several defaults are stricter.

### Added

- Environment filter for every child process: panes, command routines and
  every program Swarmterm itself starts (git, editors, MarkText, reveal in
  Explorer, WSL/Codex/OpenCode probes, the buzzkey companion) get a filtered
  copy of the app's environment. **Settings → Terminal → Environment**:
  **Hide secrets** (default) drops secret-looking names (`*_API_KEY`,
  `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_PAT`, `*_DSN`, `PGPASSWORD`,
  `MYSQL_PWD`, `AWS_*`/`ANTHROPIC_*`/`OPENAI_*`/`AZURE_OPENAI_*` credentials
  and more) and values that are URLs with credentials; **System variables
  only** keeps just the Windows variables a shell needs; **Always pass these
  variables** is an allow list (prefixes with `*`). The policy is saved in
  the app data folder (`env-policy.json`) and applies to panes restored at
  startup. Git run by Swarmterm always passes `-c core.fsmonitor=`.
- Agent safety: bypass launch modes (Claude Bypass and **Auto**, Codex YOLO,
  Gemini/Qwen YOLO, Copilot allow-all, Cursor force) ask for confirmation
  before launch and mark the pane with a red badge.
- **Settings → Terminal → Agent safety**: **Allow agents to run prompts in
  other panes** (War Room execute, off by default) and an opt-in for
  `worktree.spawn` workers to inherit a bypass mode (off by default).
- Administrator policy from `HKLM\Software\Policies\SwarmtermGN` (then
  HKCU; HKLM wins per value), read once at start and enforced in the
  backend: `DisableBypassModes`, `DisableWarRoomExecute`, `DisableWarRoom`,
  `DisableWorktreeSpawn`, `DisableMcp`, `DisableCompanion`,
  `DisableModelDownload`, `DisableRoutineCommands`, `DisablePreviewBrowser`,
  `EnvPolicy` (`default`/`strict`) and `EnvAllow`. Invalid or unreadable
  values fail closed. Locked controls are greyed out with "Managed by your
  administrator" and Settings lists the active policies. ADMX/ADML
  templates for Group Policy and Intune are in `docs/admin/`
  ([admin-policy.md](docs/admin-policy.md)).
- **Swarmterm GN Corp** edition, a second installer
  (`Swarmterm.GN.Corp_<version>_x64-setup.exe`): own identifier
  `com.apooooh.swarmterm.gn.corp`, installs per machine, with
  `DisableBypassModes`, `DisableWarRoomExecute`, `DisableCompanion`,
  `DisableModelDownload` and `EnvPolicy=default` compiled in (the registry
  can add locks, never lift them); the buzzkey installer/updater and the
  speech-model download are not in the program. Both editions install side
  by side ([editions.md](docs/editions.md)).
- Release assets: CycloneDX SBOMs (`sbom-rust.cdx.json`,
  `sbom-rust-host.cdx.json`, `sbom-npm.cdx.json`), `SHA256SUMS.txt` over all
  assets, and signed build provenance for every asset
  (`gh attestation verify`).
- Documents: [PRIVACY.md](PRIVACY.md), [TERMS.md](TERMS.md),
  [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md),
  [security model](docs/security-model.md), [editions](docs/editions.md),
  [enterprise deployment](docs/enterprise-deployment.md) (incl. download
  verification), [administrator policy](docs/admin-policy.md), the corporate
  security review pack in [English](docs/corp-review/review-pack.en.md) and
  [German](docs/corp-review/review-pack.de.md),
  [decisions](docs/decisions.md) and
  [maintainer to-dos](docs/maintainer-todos.md).
- Swarmterm GN is stated to be an independent project: it started as a fork
  of duongducnguyen/swarmterm and is no longer based on or synced with it.

### Changed

- **Behaviour change:** secrets in Swarmterm's own environment no longer
  reach panes, routines or helper programs by default. An agent that
  authenticates through an environment variable (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, …) needs
  that name in **Always pass these variables**, or log in through its own
  configuration (`/login`, Swarmterm accounts), which is unaffected.
- **Upgrade:** the first start after upgrading uses the default filter
  (**Hide secrets**, empty allow list) until Settings has saved a policy.
- **Behaviour change:** Claude **Auto** (`--permission-mode auto`) counts as
  a dangerous mode: confirmed, badged and locked by `DisableBypassModes`.
- **Behaviour change:** workers started by `worktree.spawn` no longer
  inherit a bypass mode from the spawning pane unless the Agent safety
  setting allows it.
- **Behaviour change:** War Room execute by agents is refused unless
  allowed in Settings; the check runs in Rust. Probes and your own sends
  still work.
- **Behaviour change:** the MCP server requires `Authorization: Bearer
  <token>`; other schemes are refused. Each pane gets a random secret token
  (`SWARMTERM_SESSION`, rotated on respawn) that is separate from the public
  pane id shown to War Room peers. A pane started by an older version and
  still running in the terminal host may need a restart to reach MCP.
- **Behaviour change:** Markdown and other previews no longer load plain
  `http:` images (the alt text shows instead); `https:`, relative and data
  images still load. The release CSP also gains `object-src 'none'`,
  `base-uri 'self'` and `form-action 'none'`, and the dev-server socket is
  only allowed in dev builds.
- Preview webviews (web preview column, popout) no longer have access to
  the app's IPC; the capability is scoped to the main window.
- Corp settings are separate from the Standard edition's and are not
  migrated (different identifier and app data folder).

### Removed

- Google Analytics telemetry. Swarmterm GN sends no telemetry or usage data;
  the release workflow fails if a built executable or the renderer contains
  an analytics endpoint.
- The disabled Tauri updater plugin, its tray entry, update dialogs and the
  `latest.json` helper. The app never checks for or downloads updates of
  itself; install new versions from GitHub Releases or your software
  distribution.

### Security

- Supply chain: third-party GitHub Actions pinned to full commit SHAs,
  workflows start with no token permissions, release builds use
  `--locked`, no build cache and the Rust toolchain from
  `rust-toolchain.toml`; npm packages install without scripts after
  `npm audit signatures`. CI adds `cargo deny` (advisories, licences,
  sources), `npm audit`, CodeQL, OpenSSF Scorecard and a REUSE licensing
  lint; Dependabot and CODEOWNERS are configured.
- Dependency updates clear the RustSec findings (rustls, webpki, tokio,
  plist, chacha20, clipboard-win); remaining unmaintained crates are
  documented in `deny.toml`.
- Launch-line checks read the agent command with each shell's quoting and
  ignore worker briefs only when they are safely quoted; briefs are quoted
  safely for PowerShell, cmd, POSIX shells and fish. A refused launch also
  stops a surviving detached host pane.
- Licensing is REUSE compliant (`REUSE.toml`, `LICENSES/`,
  `third-party-licenses/`).

## [1.25.4] - 2026-10-29

- Media: images detected in pane output load their thumbnail in the strip and
  popup right away; the click-to-load gate is gone (clicking still opens the
  image large, the panel never opens by itself).
- Media: an image wider than the panel is centred and scaled to fit instead of
  sitting off to the right (the panel column grew to the image's natural
  width).

## [1.25.3] - 2026-10-30

1.25.0, 1.25.1 and 1.25.2 were tagged but never published: their release checks failed (Rust formatting and one Clippy lint, then the new priority tests could not find `ping` and `node` on the CI runner; the tests now start every program by its full path). 1.25.3 ships the same changes.

## [1.25.0] - 2026-10-29

- Process priority: every process in a pane is now held below Normal by a
  Windows Job Object from the moment it starts, replacing the 1.24.2 watcher
  that lowered processes every 500 ms and could be escaped. Processes cannot
  raise themselves back or break away, and orphans (a parent that exited)
  stay covered.
- Settings → Terminal → Process priority: choose the mode (Strict, the
  default, caps the whole pane including the agent; Agent stays Normal caps
  only what the agent starts; Off), the pane and build levels (Below normal
  or Low), and an optional CPU cap in percent of the machine per pane. The
  old on/off setting is migrated; the per-workspace opt-out stays.
- Agents installed through npm (Claude Code, Codex, Gemini and others running
  under `node`) are recognised by their command line, so what they start is
  lowered too.
- When the running terminal host is from an older version, new panes run in
  the app, where the limits are enforced, and Settings says why. Panes already
  on the old host stay unlimited until it exits.
- Not covered: processes Windows starts on an agent's behalf (WMI, Task
  Scheduler, services, COM, Explorer). A process a shell profile starts before
  the pane is capped, and that already has its own job, has its class forced
  on every check instead. See `docs/adr/0005-job-object-priority.md`.

## [1.24.2] - 2026-10-25

1.24.0 and 1.24.1 were tagged but never published: their release checks failed (Rust formatting, then two tests that were too strict for the CI runner). 1.24.2 ships the same changes.

- War Room: messages now reach real agent panes whose status line or cursor
  keeps repainting (they stayed held before), and never get typed into an
  unsent draft in the agent's input box. The ⏸ badge explains why a message
  is held, with "Deliver now" for a busy pane.
- War Room: type `@` in the composer to mention peers, with autocomplete. A message
  with mentions goes only to those peers, and `@everyone` goes to the whole room.
  Mentions of anyone outside the room block the send.
- Performance: one pane's slow resize, creation or flood no longer stalls
  the others. Keystrokes, acks and resizes skip the app-wide terminals lock,
  acks run off the UI thread, and a per-pane worker applies only the latest
  size (a failed resize is logged).
- Performance: opening a workspace creates its panes in parallel instead of
  one after another, so restoring many agents is faster.
- Performance: the explorer stays current during a file watcher event storm
  (e.g. `cargo build`): a rescan at once, then changed paths at most every
  16 ms, and a final rescan after 500 ms of quiet (1.23.0 waited for quiet).
- Performance: output flow control pauses a pane only when it is more than
  2 MB behind (was 512 KB), and closing or respawning a pane always
  releases it.
- Rendering: every pane gets a WebGL renderer when it opens, as in 1.22.1,
  up to 16 (1.23.0: only visible panes, at most 12); beyond that the oldest
  pane falls back to the DOM renderer. Hidden panes keep their renderer, so
  switching workspaces is instant, at the cost of more GPU memory. With 8 or
  more panes visible and 4 or more flooding (over 64 KB/s for 3 s), the
  floods move to the DOM renderer and return to WebGL once below 32 KB/s.
- MCP: a restarted app waits up to 10 s for its previous port (e.g. while
  the old instance is still shutting down after an update) before falling
  back to a new one, so reattached panes keep their MCP connection.
- Performance: processes started by an agent CLI in a pane (builds, tests,
  tools) run at below-normal priority, so heavy agent work no longer slows the
  app and your typing. On by default (Settings → Terminal), with a saved
  per-workspace opt-out.
- Media: long paths in hard-wrapped tables are detected whole. The thumbnail
  strip keeps 50 items and scrolls sideways (wheel, scrollbar, arrow buttons
  and keys), and drag-pan works at any zoom.
- Dev: optional profiling build feature (dev only, not in releases) with
  lock, flow-gate and IPC counters for `flood.ps1 -Profile`.

## [1.24.1] - 2026-10-25

Tagged but not published (release checks failed on two tests); see 1.24.2.

## [1.24.0] - 2026-10-25

Tagged but not published (release checks failed on rustfmt); see 1.24.2.

## [1.23.0] - 2026-10-23

- Media panel: a new right-panel tab to inspect images and videos while agents
  work, from any folder (not only the project). Large viewer, thumbnail strip
  (newest first, source pane and time), wheel zoom toward the cursor (10%–2000%)
  and pan. It is user-side only: no MCP tool, nothing is passed to agents, and a
  file is served to the viewer only after you open it.
- Media detection: image and video paths printed in a pane are listed by name
  and counted in a pane badge; clicking opens the file. The media routes answer
  only the main window, never the web-preview webviews.
- Media: opt-in auto-show popup (Settings → Media) listing the newest items,
  hides itself unless you interact, never takes the keyboard.
- Media: opt-in clipboard capture (Windows) saves copied images to a temp
  folder (capped, deleted on exit and when switched off).
- Media: drag a thumbnail into a pane to insert its path like Ctrl+V does, so
  Claude Code and Codex attach the image.
- Media: Annotate images with pen, marker, line, arrow, rectangle and ellipse,
  then save a marked copy and drag it into a pane. The original is never
  modified.
- Terminal drop: paths with `%` are no longer expanded by cmd panes.
- Workspaces: new setting *Open new workspaces on startup by default*
  (Settings → Workspaces → Open on startup, off by default). Newly created
  workspaces are pinned to the startup list; existing ones are untouched, and
  auto-pinning stops at 8 because pinned entries are never evicted.
- Accounts: switching subscription on a pane whose session has no transcript
  yet now starts fresh instead of running `--resume` on an unknown id (Claude
  exited with "No conversation found" when session sharing was on).
- Performance: the file watcher stops handling individual events during an
  event storm (a batch of 64+ raw events, e.g. `cargo build` or `npm install`
  under the root) and sends one rescan once the tree has been quiet for
  500 ms. With nothing pending it blocks without an idle tick (was a 100 ms
  poll); stop is a channel message, so unwatching still releases the root at once.
- Performance: the terminal host's mode tracker skips plain text with
  `memchr` to the next ESC instead of parsing byte by byte (same results).
- Performance: end-to-end output flow control. The renderer acks output once
  xterm parsed it; a pane more than 512 KB behind pauses its output (resumes
  below 128 KB) and the shell is backpressured, so floods no longer grow
  WebView memory by GBs. Applies in-process and in the terminal host (new
  `ack` op, `flow-control` capability; older apps are never gated). The gate
  opens on detach, exit or 2 s without an ack; input is never gated.
- Performance: terminal output reaches the renderer as raw bytes instead of
  JSON strings (no escaping, no copy of the batch) and xterm parses them
  directly. The host connection decodes many frames per read without
  shifting its buffer per frame, and the app shares the host's output
  batching code instead of a copy.
- Memory: panes hold a WebGL context only while visible (at most 12, least
  recently shown falls back to DOM first; re-acquired after a context loss).
  New Settings → Terminal → *Scrollback* (default 5,000 lines). The terminal
  host keeps 512 KiB of replay history per pane instead of 1 MB.
- Performance: workspace tabs, the attention badge and the prompt library no
  longer re-render on every agent state flip, the agent detector skips its
  screen scan while nothing changed, and `wait_peer` waiters are no longer
  woken by every output batch.
- War Room: joining, moving, leaving or deleting a room now wakes pending
  `wait_peer` calls at once, so a peer that left is reported immediately.
- Dev: perf benchmark harness (`scripts/perf/flood.ps1`) with an "agents"
  scenario of synthetic agent-like streams; it never starts an agent CLI.

## [1.22.1] - 2026-10-19

- Terminal: emoji and other wide characters now measure 2 cells (Unicode 11
  widths), fixing stray characters and broken borders in agent TUI tables
  (e.g. Claude Code with ✅ ❌ 🔶).

## [1.22.0] - 2026-10-19

- Terminal: Ctrl + mouse wheel zooms the text of the pane under the mouse,
  of all panes (moves the global Size), or nothing — Settings → Terminal →
  *Ctrl + scroll zoom*. Per-pane zoom sits on top of the global size and
  lasts until restart. `Ctrl + 0` resets (rebindable). The wheel is not
  forwarded to TUIs with mouse tracking and never page-zooms the app.
- CI: end-to-end tests no longer flake on a cold Vite start.

## [1.21.0] - 2026-10-19

- Panes: the identity dialog can tint the pane's top bar with the identity
  color (light background, full-color bottom border; a maximized pane keeps
  its zoom border). Saved with workspaces; dropped on load without a valid
  color.
- Panes: identity icons may be any Lucide icon, loaded on demand via
  `lucide-react/dynamic`. The picker is a scrollable, windowed grid of all
  icons (current icon, suggestions, then A–Z) with name search.
- Panes: the identity palette grows from 10 to 20 colors (orange stays out,
  it marks War Room execute messages).
- Panes: clicking the identity name in the header opens the identity dialog.

## [1.20.0] - 2026-10-18

- Panes: identity — an icon (curated lucide set or one emoji), a name and a
  palette color per pane, edited in one dialog from the header's icon slot or
  the pane context menu (*Set identity…*). The header shows the name in bold
  with the agent title muted beside it; the sidebar list and the War Room
  avatar show the icon. Kept with saved workspaces (re-checked on load);
  never respawns the pane.
- Composer: optional workspace *Name*; blank keeps the folder-derived name.
- Fix: renaming a workspace while the focused pane had a file open could hand
  the keyboard to the editor on a click inside the field, committing a
  half-typed name. Focus return now leaves a focused text field alone, and
  the rename inputs keep key and pointer events from the draggable row.

## [1.19.0] - 2026-10-18

- Accounts: a workspace keeps the composer's account choice per agent (fixed
  profile or round robin), also in saved workspaces. Split panes use it: the
  fixed profile, or the next account in the rotation. Without a choice, a
  split pane takes the account of the pane it was split from (same agent).
- Accounts: switching the account of a pane whose conversation has not had a
  turn yet (for example a pane just split off) now restarts it on the new
  account instead of failing with "Session not found in the source
  subscription".
- Settings → Appearance: **Highlight panes by agent state** is on by default
  for anyone who has not changed it.
- Build: the built-in speech engine (whisper.cpp) is the default Cargo
  feature `local-speech`. `--no-default-features` (`npm run
  tauri:dev:no-speech`, `npm run test:rust:no-speech`) builds and tests
  without LLVM and CMake; built-in dictation then reports that it is not
  available. Release builds keep it. CI also lints the build without it.

## [1.18.0] - 2026-10-18

- Panes: every open pane shows a number in its header and the navbar list,
  and can be renamed by double-clicking its title. Names are kept with
  saved workspaces and never restart the pane.
- Voice: spoken pane addressing (BUZ-5). The voice pipe gains the `address`
  capability: a dictation may name its target pane by number, name or title.
  It is resolved to exactly one pane of the foreground workspace, or refused
  as missing or ambiguous; the focused pane is never taken as a guess.
  Needs a buzzkey release with addressing.
- Explorer: folders that vanished from disk are no longer kept as expanded.
- Terminal host: the installer does not ship `swarmterm-host.exe` yet
  (ADR 0001 phase 4, version-stamped install), so in installed builds the
  setting falls back to in-process panes and says why. Source builds can use
  it after `cargo build -p swarmterm-host`.
- Settings: toggle switches no longer overflow their track.
- Internal: terminal host crate `src-tauri/host` (`swarmterm-host.exe`,
  ADR 0001 phase 1, SWA-54): named-pipe protocol v1, PTY ownership with a
  replay ring. Not used by the app yet.
- Settings → Terminal: **Run new panes in the terminal host** (preview, off by
  default; ADR 0001 phase 2, SWA-55). New panes spawn in `swarmterm-host.exe`;
  MCP, War Room, voice and hooks work unchanged. Keystroke round trip over the
  host pipe: p99 under 0.1 ms.
- Terminal host: a host with no client and no pane exits after ten minutes, and
  a client replaced by a newer connection is now disconnected instead of being
  left open without output.
- Terminal host: panes survive an app crash (ADR 0001 phase 3, SWA-56). With the
  host switched on, reopening a saved workspace takes over its panes that are
  still running instead of starting them again: the output so far is replayed
  (full-screen programs such as Claude Code repaint in place), and agents keep
  their MCP connection when the previous port is free. Panes no saved workspace
  references are closed after startup, and all of them if the host was switched
  off in the meantime. Saved workspaces store pane ids only while the host is
  on. Quit still closes every pane.
- Release: winget manifest generator (`scripts/release/winget.mjs`,
  per-user NSIS) and an opt-in `winget` job in the release workflow that
  runs a pinned komac after publishing. Skipped until the `WINGET_TOKEN`
  secret and `WINGET_PACKAGE_ID` variable exist; nothing is submitted yet
  (SWA-43).

## [1.17.0] - 2026-10-18

- Voice: spoken replies for Claude Code (SWA-58). With Settings → Voice →
  "Allow excerpts" on (off by default, needs "Speak announcements"), Claude
  is asked to end each answer with a short `<voice>` line, and Swarmterm
  says that line after the turn instead of "fertig" — also for the pane you
  are looking at — else the first sentences of the answer, else the status.
  Failed turns (StopFailure) and turns stopped with Esc are said in the same
  conversational tone and shown in the bell. The text is read from the
  agent's own session file, filtered, kept only in memory and never sent
  anywhere; the voice pipe is unchanged. See
  `docs/adr/0004-reading-agent-output.md`.
- Voice: buzzkey update notice. With buzzkey installed and connected,
  Swarmterm checks for a newer signed buzzkey release at start and every
  24 h and offers "Update now" or "Later" (remembered until the next
  version). Opt-in "Update buzzkey automatically" installs without asking,
  never during a dictation and never across a major version without
  asking once. Same signature-first install as before; buzzkey is quit
  over the pipe, never killed.
- Panes: optional agent-state highlight. Settings → Appearance → "Highlight
  panes by agent state" frames each agent pane in its state colour — yellow
  while working, drifting to orange over a chosen 5/10/30 minutes, red when
  blocked, green when it finished in the background until focused. Off by
  default.
- Voice: better built-in speech models and a suggestion per PC. Settings →
  Voice now offers quantised Small, Medium, Large v3 Turbo (q5/q8) and
  Large v3 models and recommends the best fit for this computer (CPU
  threads, RAM, AVX2) with a short reason, "Download and use" and "Measure
  again". New installs default to Small q5 instead of Base; tiny/base/small
  stay available as legacy. Transcription uses up to 16 CPU threads.
- Fix: a late Stop of an earlier Claude prompt no longer ends the turn in
  progress or announces it as finished.
- Fix: Esc after opening a pane header's ⋯ row from the keyboard keeps the
  focus on ⋯ instead of sometimes moving it into the terminal.

## [1.16.0] - 2026-10-17

- Routines: command routines (SWA-67). A routine can run one shell command
  line on a schedule instead of an agent, in the background without a pane
  or tokens, stopped at its time limit. Only failures go to the bell; every
  run's exit code and duration show under Last run.
- Terminal: Shift+Enter in an agent pane inserts a line break instead of
  submitting the prompt (SWA-60). xterm sent the same carriage return as
  Enter, so Claude Code sent each line of a multi-line prompt on its own.
- Voice: spoken announcements (SWA-66). With Settings → Voice → "Speak
  announcements" on, Swarmterm says "<pane>: fertig" / "<pane> wartet auf
  Eingabe" itself, using an installed Windows voice (no download). Typing,
  focusing that pane, dictating or Ctrl+Shift+M stops it; nothing is spoken
  while a dictation records. `turn` pushes carry `ttsHandled` so buzzkey's
  fallback voice never talks over it. See `docs/adr/0003-builtin-announcements.md`.

## [1.15.0] - 2026-10-17

- Voice: install and control buzzkey from Settings → Voice (SWA-42). The
  newest signed buzzkey release is downloaded only on click, its signature
  and checksums are verified before anything is installed, and Quit asks
  buzzkey to exit instead of killing it.
- Accounts: sessions can be shared across subscriptions (SWA-64), so a
  conversation started under one account can be resumed under another.
- Workspace: docked pane headers can be dragged again.
- Voice: built-in speech recognition (SWA-38). Settings → Voice downloads
  a Whisper model (checksum-verified) and enables local dictation without
  buzzkey: Ctrl+Shift+Space or the pane-header microphone starts and stops,
  the text arrives as a draft in the pane that had the keyboard. Only
  downloaded models can be selected, and the shortcut reports a missing
  model in the bell instead of doing nothing. Runs on the
  CPU; see `docs/adr/0002-builtin-speech-source.md`.
- Saved workspaces can open on startup (pin on the card, the navbar workspace menu or Settings →
  Workspaces → Open on startup, with order); Welcome is skipped while any is set.
  Startup workspaces are exempt from the 24-entry limit.
- Voice: optional status announcements. With Settings → Voice → "Announce
  finished agents" on, a dictation app can subscribe to "agent finished" and
  "needs your input" for panes you are not watching. Only the status and the
  pane title leave the app, never pane output. Off by default.
- Docs: ADR 0001 (accepted) adopts a separate terminal host process so terminals
  can outlive quit and app updates (`docs/adr/`).
- Floating panes: no longer move or resize when the sidebar or the right panel
  is toggled, can be dragged over both, and move freely by their header
  (dock with the Dock button).

## [1.14.2] - 2026-10-16

- Files: live refresh holds one watch on the explorer root instead of one
  per folder, so folders below it can be renamed and moved again while the
  tree is open (Windows refused with "Access denied"). After heavy file
  churn the tree re-reads its open folders.

## [1.14.1] - 2026-10-16

- Claude Code hooks and status line: a development build no longer takes
  the `~/.claude/settings.json` entries over from a live installed
  Swarmterm, so deleting a dev checkout can no longer leave every hook
  pointing at a missing `target/debug/swarmterm.exe`.

## [1.14.0] - 2026-10-16

- Composer: new workspaces start from configurable defaults (folder,
  terminal count, agents and accounts, worktree isolation, Split opens).
  "Save as default" stores the current choices; Settings → Workspaces can
  reset them to the built-in values. Agents that aren't installed are left
  out when a default or template is applied.
- Workspace templates: "Save as template…" in the composer and a Template
  picker; Settings → Workspaces edits the defaults and adds, edits,
  duplicates and deletes templates.
- Right panel: while closed, rest the mouse on the right edge to slide it in
  over the workspace; pin docks it (Settings → Appearance → Peek right panel
  on right edge).
- Composer: lists only installed agents; smaller layout preview; the agent
  legend is removed.

## [1.13.0] - 2026-10-16

- Sidebar: while the sidebar is hidden, rest the mouse on the left edge to
  slide it in over the workspace (Settings → Appearance → Peek sidebar on
  left edge).
- Notifications: the bell now reports when the MCP server stops, when voice
  input fails (cleared again once it recovers) and when a pane stopped
  reading input so a paste was dropped. These entries show their details and
  are marked read on click.
- Pasting a large block (over 8 MiB) into an idle pane is no longer rejected.
- War Room: messages are limited to 64k characters, and an unread inbox keeps
  at most 200 messages; older ones are dropped and the reader is told how
  many were lost.
- Git: the changed-files list shows renames correctly and handles paths with
  spaces or non-ASCII characters.
- Worktrees: clearing a worktree on a detached HEAD works, and clearing
  refuses to delete a branch that does not match the worktree.
- Codex: support detection runs at startup, so new Codex panes no longer wait
  for it; a slow first check is retried later.
- Performance: the sidebar and the file tree re-render less.
- Fixes: event listeners are cleaned up when panes and dialogs close, dialogs
  no longer show results of an earlier request, and closed panes no longer
  leave titles, previews or War Room members behind.

## [1.12.0] - 2026-10-15

- Settings: new **Title bar** page. Reorder the pane-header controls by drag
  or arrow buttons and set each to Core, Can hide, ⋯ only or Off; Reset to
  defaults restores the original header. Layouts are remembered.
- Pane header: on narrow panes the agent, title, folder, maximize and ✕ stay
  visible and the other controls collapse behind `⋯`; hovering the header (or
  clicking `⋯`) shows them in a second row.
- Pane zoom: a maximized pane shows a violet border and a restore button with
  the number of hidden panes; the sidebar marks the maximized pane and dims
  the hidden ones.
- Layout: double-click a separator or corner handle to even out the panes.
- Closing a pane shuts agents down gracefully before stopping their processes,
  so Claude Code no longer disables its fullscreen renderer machine-wide.
- Performance: PTY output is coalesced, sidebar resize and terminal refits are
  batched per frame, blocking work stays off the main thread, and session
  titles are cached.

## [1.11.0] - 2026-10-15

- Settings: switching Swarmterm's Claude status line no longer fails when
  your Default account uses its own status line, and account profiles now
  follow the switch in that case too.
- Accounts: Claude Code panes on a named profile now also get your hooks
  and `permissions.deny`/`ask` rules from the Default account, so guards
  such as a data-masking hook apply there too. `permissions.allow` is never
  copied.
- Accounts: Claude Code panes on a named profile now show your own status
  line and load your user-level MCP servers from the Default account,
  instead of only Swarmterm's status line and server.
- Accounts: the last known usage survives a restart and shows its age;
  Codex usage refreshes after each turn and every minute while Settings >
  Accounts is open.

## [1.10.1] - 2026-10-12

- Release checks: the accounts browser test follows the add-account wizard.
  1.10.0 was tagged but never published.

## [1.10.0] - 2026-10-12

- Voice dictation shows a "Listening…" pill with a Stop button in the pane
  the dictation will land in, while you speak (needs buzzkey with protocol
  negotiation). Stop discards the dictation. Changing auto-Enter in
  Settings → Voice no longer cancels a dictation in progress.
- Accounts: an add-account wizard creates a Claude Code or Codex profile and
  opens its login in one step; account cards show the login status.

## [1.9.0] - 2026-10-12

- Voice dictation: a local dictation app (buzzkey) can type into the pane
  that had the keyboard when you started speaking, even if focus moves
  while it transcribes. Text arrives as a draft, never redirected, never
  into a pane waiting on a permission prompt; plain shells get one line.
  Named pipe for your Windows user only, with a per-launch key. Settings →
  Voice switches it off or allows auto-Enter.

## [1.8.0] - 2026-10-12

- Routines: run Claude Code or Codex with a saved brief on a schedule
  (time of day with weekdays, or every N minutes) while the app is open.
  Each run opens a new pane in the active workspace, optionally in a fresh
  git worktree; never overlaps itself, and missed runs are caught up once
  or skipped, never in a burst. Outcomes land in the notification bell.

## [1.7.0] - 2026-10-12

- Prompt library: save prompts locally and send one to a running Claude Code
  or Codex pane (held while you type or the agent works, sent once) or
  start it in a new pane next to the focused one, optionally in a fresh git
  worktree. Title bar button or the "Open prompt library" action.

- Conversation view: a pane running Claude Code or Codex gets a header
  button that shows its session as a read-only conversation, read from the
  CLI's own session file (newest part for long sessions, tool steps
  optional). Nothing in it can type into the pane or approve anything.

- Handoff shows the target account's usage: Claude Code's 5-hour and
  7-day rate limits travel with the Swarmterm status line and are kept per
  account profile, with the time they were taken. Codex stays "unknown".

## [1.6.0] - 2026-10-12

- Handoff fixes: closing the new pane before its agent reports in now ends
  the handoff instead of waiting forever; failures before Send (spawn error,
  exit, closed pane) reach the notification bell; a ready pane whose agent
  is never recognised on screen explains why Send stays locked. The folder
  picker opened from Settings keeps its focus trap, and Esc closes the
  picker rather than Settings.
- Account and agent handoff: from the Handoff brief, pick a Claude Code or
  Codex account profile and start a new pane in the same folder; the brief
  is sent as its first prompt only after the pane runs, its process is
  unchanged and you confirm. One attempt, typing/agent hold respected, no
  retry, old pane untouched, outcome listed in the notification bell. Usage
  shows "unknown" with a timestamp unless a CLI reports structured data.
- Handoff brief: a pane header button opens an editable brief with task,
  status, open items, tests, agent/account/folder/session and branch, HEAD
  and a diff reference. User-written fields are labelled as unverified, an
  optional terminal excerpt is marked incomplete, and the brief is only
  copied, never sent.
- Choosing a folder now opens an in-app picker instead of the Windows
  dialog: favorites you pin, recent and saved-workspace folders, type-to-filter
  and path jumping, keyboard navigation, and a "Windows dialog" fallback.
- Tidy layout (workspace menu **⋮ → Tidy layout**, or a key you assign to the
  action): sizes every row and column of panes equally, even when the split
  tree is lopsided, so `[A | [B | C]]` gives A, B and C a third each. Drawered
  and floating panes are left out; only sizes change.
- Resizing a pane quickly no longer scrambles Claude Code and Codex output.
  xterm now knows it runs on ConPTY (with the Windows build number, like
  VS Code), and the pty hears only the final size once a resize settles,
  so the agent redraws once instead of for every intermediate step.
- Float a pane above the layout, move and resize it freely, and dock it
  onto any pane by dragging its header.
- Resize panes from the corner: drag the handle where a horizontal and a
  vertical separator meet to change width and height in one move.
- Notification center: a bell in the title bar lists panes that need input,
  finished agents and long commands, exited processes and held War Room
  messages across all workspaces. Clicking an entry reveals and focuses its
  pane (other workspace or drawer) and marks it read.
- A shell that exits on its own (typed `exit`, crash) now ends the pane on
  Windows. Previously ConPTY kept the output pipe open, so the pane never
  showed "Process exited".
- Pin each Codex pane to its own app's MCP server, so a development build
  running next to the installed app no longer redirects Codex away from the
  War Room. Codex session hooks start without a nested PowerShell, stale
  duplicate hook entries are removed, and Codex asks once to trust the
  updated hook.
- War Room: reading the inbox no longer loses messages. Read messages stay in
  a short history that `war_room.read_inbox` returns with `includeRead`, so a
  probe reported as delivered is still visible after the agent read it on the
  nudge.
- War Room: agents connect without setup. A pane counts as connected as soon
  as its agent's MCP client reaches Swarmterm, not after its first War Room
  call. Member chips and the pane header show connected, waiting or an error
  with the reason.
- Settings → MCP: an on/off switch per agent and account for Swarmterm's own
  MCP entry. Off removes only Swarmterm's entry and leaves other servers
  untouched; details are collapsed.
- OpenCode panes join the War Room automatically. The server is passed to
  each pane through `OPENCODE_CONFIG_CONTENT`, and `opencode.json` is never
  written.

## [1.5.2] - 2026-10-11

- Add an Auto launch mode for Claude Code (`--permission-mode auto`).

## [1.5.1] - 2026-10-11

- Release 1.5.0 again; its release checks failed on two browser tests still
  expecting Claude Code to launch with bypassed permissions. 1.5.0 was never
  published.

## [1.5.0] - 2026-10-11

- Park terminals in a per-workspace drawer (archive button or Ctrl+Shift+D);
  their shells keep running and one click in the sidebar restores them.
- Open splits with a configurable default AI provider, globally or per
  workspace; Alt+click forces a plain shell.
- Pick a default launch mode per provider. Claude Code gains Default, Accept
  edits, Plan and Bypass permissions modes instead of always bypassing.
- Drag a pane onto another to split beside it, or drop it on a snap layout
  preset (side by side, stacked, grid, main-left, main-top).
- Paste clipboard screenshots into Claude Code and Codex panes with Ctrl+V.
- Choose folder now starts in the workspace folder.

## [1.4.0] - 2026-10-11

- Keep terminal creation and account configuration off the UI thread, combine
  concurrent profile/agent refreshes, and delay project scans until folder
  typing settles. Workspace macros share a single fresh metadata probe.

- Manage separate Claude Code and Codex account profiles, select or rotate
  accounts when composing panes, and restore conversations with their owning
  profile. Credentials stay in the agent CLI's configuration.
- Customize app shortcuts, detect conflicting bindings and save workspace
  macros for common pane layouts without storing terminal commands.
- Add reviewed MCP server definitions to default or named accounts through
  Settings. Preserve existing configuration, show conflicts and complete
  authentication in the agent CLI; Playwright runs headless.

- Save up to 24 workspaces locally and reopen them from Welcome with their
  split layout, shells, agents, folders, launch modes and worktree bindings.
  Rename or forget saved entries without stopping an open workspace.
- Capture exact Claude Code and Codex session identities through lifecycle
  hooks so panes in the same folder reopen their own conversations. Codex
  hooks use the normal `/hooks` trust flow and supported panes run with
  `--no-daemon`. Missing folders, sessions or CLIs show a fallback notice.

## [1.3.1] - 2026-10-10

- Release 1.3.0 again; its release checks failed on two browser tests still
  using HTML5 drop events. 1.3.0 was never published.

## [1.3.0] - 2026-10-10

- Fix a stray `^[[I` / `^[[O` above the Claude Code banner when focus moved
  while the agent was starting. Focus reports are no longer fanned out to
  broadcast members or counted as typing for War Room deliveries.

- Ctrl+drag a detected file path from a terminal onto another pane to insert
  it there; Ctrl+click still opens it. File names in a PowerShell `dir` /
  Get-ChildItem listing are links too, resolved against its Directory header;
  folders (rows and header path) can be Ctrl+dragged, Ctrl+click shows them
  expanded in Files.
- Fix Ctrl+click on absolute Windows paths opening the file externally
  instead of in the editor (verbatim `\\?\` paths failed the project check).

- Dragging from Files now shows a proper copy/move cursor and a label under
  the pointer instead of the Windows "no-drop" sign; Ctrl copies into a
  folder, Esc cancels. No OS drag loop is involved any more. File tabs
  drag between panes the same way (that HTML5 drag never landed on Windows).

- Sidebar "Auto" layout (new default): Workspaces and Terminals take their
  content height, Files fills the rest. "Manual" keeps the resizable
  sections (Settings → Appearance → Sidebar).

- Maximize a pane to fill its workspace (header button, header double-click
  or Ctrl+Shift+Enter); the other panes keep running.

- Ctrl+Shift+Backspace clears the pending input line of the focused terminal
  without quitting a running agent.
- Fix the last terminal row slipping under the pane border after resizing.

- SVG and HTML files open with Editor / Split / Preview modes, updated live
  while typing. SVG preview with wheel zoom, pan, Fit/100 % and background
  choice; HTML preview with relative assets and sandboxed scripts. New
  "Browser" button opens the file in the system default app.
- Drag files or folders from Files onto a terminal pane to insert their
  quoted paths, like a drop from the OS file manager. Claude Code panes get
  relative `@` mentions instead (`@src/foo.ts`).
- Ctrl+clicking a file path in a terminal also selects it in Files, expanding
  its folders and scrolling to it.

- Codex panes start in a selectable launch mode (Auto, Safe, YOLO) passed as
  CLI flags; switching restarts Codex and continues the session. "Resume previous chat…"
  takes over an older Codex chat in the pane.

## [1.2.0] - 2026-10-10

- Open Markdown files rendered by default in a MarkText-style reading view;
  the default view is configurable under Settings → Files.
- Add "Open in MarkText" to the file toolbar and explorer context menu, with
  auto-detection of the MarkText install and an optional path override.
- Hash the published installer filename in the release checksums.

## [1.1.0] - 2026-10-10

- Add all seven Astera themes, bundled UI fonts and theme-specific density,
  corners, shadows and preview cards. Running terminals change palette in place.
- Add a resizable Files section that follows the selected terminal's configured
  project/worktree, with a virtual tree, git badges, multi-selection and file operations.
- Add native file clipboard import/export, internal drag-and-drop, progress,
  undo and bounded local deletion history with collision-safe restore.
- Add shared CodeMirror file tabs, language highlighting, find/replace, CRLF/BOM
  preservation, dirty-close guards and external-change conflict resolution.
- Add sanitized GFM Markdown previews, synchronized split scrolling, heading
  links and preview search, plus image/video previews with stable-change reload.
- Run supported files in a dedicated plain-shell pane, and open project paths
  printed in terminals in the integrated editor without respawning the PTY.
- Brand the fork as Swarmterm GN and disable upstream updater endpoints.
- Add headless integration coverage and Windows Rust CI checks.
- Add a tag-triggered Windows installer release workflow with version checks,
  release notes, SHA-256 checksums and publication after successful checks.
- Support Windows x64 in the GN fork; retain upstream platform code and history.

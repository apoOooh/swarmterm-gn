# CLAUDE.md

Guidance for AI agents working in this repo. Keep it lean — it points at the
code and docs rather than duplicating them. When this file and the code
disagree, **trust the code**.

## What this is

**Swarmterm** — a desktop multi-terminal app: a left navbar of workspaces, each
a binary split-tree of real terminal panes (xterm.js front, `portable-pty`
shell back), plus an optional Chrome-style web-preview column. Built on
**Tauri 2 + Rust** (frontend: **React 19 + TypeScript + Vite**). Ported from an
earlier Electron app; workspace structures and known agent session references
are persisted locally, while terminal output and unsaved buffers are transient.

`README.md` is a short user-facing intro (the pitch, install, first run) and
`docs/user-guide.md` is the detailed end-user guide — both English, no code
guidance. The manual smoke-test checklist is `docs/manual-smoke-tests.md`.
Update them when you ship user-visible behaviour: new features go into the
guide (and README only if they change one of its three core ideas).

**Supported platform:** the GN fork supports Windows x64 only. CI and release
bundles target Windows; retained upstream macOS/Linux code is not a support
commitment. Preserve platform guards when editing inherited Rust code.

## Commands

Run from the repo root unless noted.

| Command | What it does |
|---|---|
| `npm install` | Install JS dependencies. |
| `npm run tauri dev` | Run the full app (Vite HMR frontend + Rust auto-rebuild). |
| `npm run tauri:dev:isolated` | Same, as a **separate instance** (`com.apooooh.swarmterm.gn.dev`). Use this whenever Swarmterm is already running — see below. |
| `npm test` | Run the JS/TS unit suite (Vitest, run-once). |
| `npm run test:watch` | Vitest in watch mode. |
| `npx tsc --noEmit` | Type-check the whole frontend (strict). |
| `npm run build` | Frontend-only build (`tsc && vite build`) — no Rust. |
| `npm run logo` | Regenerate every logo asset from `scripts/gen-logo.mjs` (also runs `tauri icon`). |
| `npm run tauri build` | Production bundle (installer). |
| `npm run tauri build -- --no-bundle` | Release binary, skip installer. |
| `cargo test` *(from `src-tauri/`)* | Rust unit tests (pty/shell helpers). |

**Running the app from inside Swarmterm.** Swarmterm is single-instance, keyed
on its identifier: a second launch with the same identifier is handed to the
running app and exits, so `npm run tauri dev` silently does nothing visible
when you (or the agent's own pane) already run Swarmterm. Agents working in a
Swarmterm pane must use `npm run tauri:dev:isolated`, which merges
`src-tauri/tauri.dev-instance.conf.json` (own identifier, app-data dir and
saved workspaces; the MCP server binds a free port anyway).

**Before claiming done:** run `npm test`, `npx tsc --noEmit`, and — if you
touched `src-tauri/` — `cargo test`. Don't assert success without the output.

## Architecture

```
┌─ Renderer (src/) ─────────────┐         ┌─ Backend (src-tauri/src/) ─┐
│ components/  React UI          │         │ lib.rs     builder/plugins │
│ store/       zustand state     │ invoke  │ commands.rs #[command] fns │
│ lib/         pure logic (TDD)  │ ──────► │ pty.rs      spawn + reader │
│ tauri/       IPC bridge ───────┼─────────┤ shell.rs    shell discovery│
│                                │ Channel │ tray.rs                    │
└────────────────────────────────┘ ◄────── └────────────────────────────┘
                                    PtyOut
```

- **`src/tauri/*` is the ONLY IPC surface.** There is no `window.api` shim. Every
  call into Rust goes through a thin typed module here: `terminal.ts` (pty
  create/write/resize/kill + the `Channel<PtyOut>` stream), `window.ts`,
  `dialog.ts`, `clipboard.ts`, `shell.ts`, `preview.ts`, `popout.ts`. New
  backend calls get a new function in one of these — components never call
  `invoke` directly.
- **`#[tauri::command]` handlers live in `commands.rs`** and delegate to module
  logic (`pty.rs`, `shell.rs`). Register new commands in the
  `invoke_handler!` list in `lib.rs`.
- **Per-terminal streaming:** each pty gets its own `Channel<PtyOut>`; a Rust
  reader thread decodes output and sends `Data` chunks, then a final `Exit`.
  The Serde tagging (`type`/`payload`, camelCase) must stay in lockstep with the
  `PtyOut` union in `src/tauri/terminal.ts`.

## Module boundaries (respect these)

- **`src/lib/`** — pure, framework-free logic, each with a `*.test.ts` beside it
  (layout-tree, web-url, templates, terminal-session, appearance, etc.). This is
  where business rules go so they can be unit-tested without a DOM or a pty.
- **`src/store/`** — zustand stores. UI state and actions only; keep pure
  transforms in `lib/` and call them from the store (see `app-store.ts` ↔
  `layout-tree.ts`).
- **`src/lib/terminal-registry.ts`** — owns the live xterm `Terminal` instances
  **outside React's render tree**, keyed by `terminalId`. Components attach/detach
  by id; the registry survives remounts so a pane re-parenting (split collapse)
  doesn't kill the shell. Don't put xterm instances in React state.
- **`src/components/`** — thin. Layout + wiring; logic belongs in `lib`/`store`.
  `components/ui/` is shadcn-style primitives (button, dropdown-menu).

## Conventions

- **Imports:** use the `@/` alias for `src/` (`@/lib/...`), configured in both
  `vite.config.ts` and `tsconfig.json`.
- **TypeScript is strict**, including `noUnusedLocals` / `noUnusedParameters` /
  `noFallthroughCasesInSwitch`. Dead code fails the type-check.
- **TDD for `lib/`:** write/extend the `*.test.ts` first. Run via Vitest.
- **Comments explain *why*, not *what*.** This codebase leans on dense rationale
  comments for non-obvious platform/lifecycle decisions — match that density when
  you add similar logic (see `pty.rs`, `terminal-registry.ts` for the bar).
- **Styling:** Tailwind (`tailwind.config.cjs`) + CSS variables in
  `src/index.css` for light/dark theming. The visual target is **VS Code** —
  mirror its chrome, palettes, and patterns closely (the terminal palette in
  `terminal-registry.ts` is VS Code "Dark Modern" verbatim).
- **Rust:** platform-specific code behind `#[cfg(windows)]` / `#[cfg(not(windows))]`;
  keep testable helpers pure with a `#[cfg(test)] mod tests` block (see
  `take_valid_utf8`).

## Gotchas (the non-obvious stuff)

- **Terminal respawn ordering.** `create_terminal` rejects a duplicate live id.
  So killing must free the id *before* the renderer retries: `kill_terminal`
  removes the entry from the map and drops the master PTY to force the reader to
  observe EOF (on Windows ConPTY the pipe stays open until the master is dropped),
  and `read_loop` removes the id from state *before* emitting `Exit`. A same-id
  respawn (agent/cwd/shell switch) waits for that `Exit`. Touch this carefully.
- **Windows process-tree teardown.** Shells are captured in a kill-on-close **Job
  Object** so closing a pane/workspace kills children/grandchildren, not just the
  shell. See `pty.rs::job`.
  Closing is graceful first (`ManagedTerminal::shutdown`): the pseudo console is
  closed so agents get CTRL_CLOSE_EVENT and run their exit handlers, and the job
  is terminated only after `KILL_GRACE` (3 s). A hard kill makes Claude Code
  count a failed fullscreen start and disable fullscreen machine-wide. Note
  `Exit` fires when the PTY closes, so a same-id respawn may briefly overlap the
  old tree's clean exit.
- **PTY I/O threads.** Input never blocks a command: each generation owns a
  writer thread (`pty::PtyInput`) and `write_terminal(_checked)` only enqueue
  under the `terminals` lock (FIFO = keystroke order; a respawn gets a new
  queue). Queued bytes are capped at 8 MiB per pty, but an empty queue always
  accepts one write (big paste into an idle pane); the writer drains in 64 KiB
  slices. `write_terminal` returns `input-queue-full`, which the renderer
  reports in the bell (`setInputDroppedHandler`, at most once per pane every
  5 s). Shutdown drops the sender; a writer parked on a full pipe is released
  by the master close. Output is a reader thread (UTF-8 split stays there)
  feeding a flusher that coalesces bursts (`next_batch`, 4 ms / 64 KB; sent at
  once after 16 ms quiet); all `Data` precedes `Exit`.
- **UTF-8 chunk boundaries.** `take_valid_utf8` buffers a split trailing multibyte
  sequence across reads to avoid mojibake (emoji/box-drawing). Don't "simplify" it
  into a lossy decode.
- **Keyboard focus belongs to the terminal.** dnd-kit stamps `tabIndex: 0` on
  every drag node (workspace tabs, navbar items, pane headers), so a click parks
  DOM focus on chrome and keystrokes are dropped — and a Tab (shell completion)
  walks the focus ring across the tab titles. Those nodes are pinned to
  `tabIndex={-1}`, and `App.tsx` hands focus back to
  `selectFocusedTerminalId(...)` after clicks inside any `data-focus-return`
  region, on workspace switch, and on window re-focus. The decision lives in
  `lib/terminal-focus.ts` — it stands down for inputs, contenteditable, and open
  menus/dialogs. New chrome that swallows clicks should carry
  `data-focus-return`; anything that owns the keyboard (Welcome, Settings, the
  right panel) must not.
- **Close-to-tray vs Quit.** Closing the window hides it to the tray (pty stays
  alive); `on_window_event` calls `prevent_close()` unless `AppState.quitting` is
  set (tray → Quit). Killing the app for real must set that flag.
- **Truecolor.** The shell is spawned with `COLORTERM=truecolor` /
  `TERM=xterm-256color`; ConPTY forwards 24-bit color and xterm renders it
  verbatim. Don't downscale.
- **MCP server & session token.** On boot the Rust process binds a random
  loopback port and runs an `rmcp` Streamable-HTTP MCP server. Each PTY is
  spawned with `SWARMTERM_MCP_URL=http://127.0.0.1:<port>/mcp` and
  `SWARMTERM_SESSION=<terminalId>`. The session UUID doubles as the bearer
  token — the terminal's env is the only place it appears, and it stops
  authorising the moment the PTY is killed (auth resolver checks the live
  terminal map). To add a tool: drop it into `src-tauri/src/mcp/tools/` and
  add one `mod` line.
- **War Room.** Multiple named rooms on `AppState.war_rooms` (`warroom.rs`:
  `WarRooms` registry over per-room `WarRoom` instances; default room seeded
  at boot, last room undeletable). A pane is in at most one room — drag onto
  a room tab (or the panel body = active room) to join/move; the MCP tools
  are unchanged and resolve the caller's room by membership (`find_room_of`).
  Every `warroom:event` carries `roomId`; `warroom:deliver` stays
  per-terminal, so the delivery/hold pipeline is room-agnostic. Each room has
  its own Moderator seat; the composer sends into the active room. Drag the
  member chip out (or ✕) → `war_room_leave`. The `war_room.*` MCP tools are
  always registered but gate per-call on live membership, so revocation is
  the map removal itself. PTY death auto-leaves (both `kill_terminal` and
  `read_loop`) — membership does NOT survive a same-id respawn; re-drag.
  Probe messages live in server-side inboxes; only a
  short nudge is typed into an idle pane (sustained idle, `NUDGE_IDLE_MS`),
  via `deliverPromptToTerminal` which bypasses broadcast fan-out on purpose.
  `mode: "execute"` pastes + runs a full prompt and is server-rejected toward
  plain-shell members. Codex enrollment rewrites `~/.codex/config.toml` with
  the concrete URL on every boot (`mcp/config.rs::register_codex`).
  "Connected" is set by the first inbound MCP request carrying the pane's
  bearer (`record_client` middleware → `connect_war_room_member`) and again
  on join if that client was already seen — no tool call needed. The
  Settings → MCP switch (`mcp/toggle.rs`) is an opt-out set every MCP writer
  consults (`register_*`, `accounts::enroll`, the Codex `-c` pin); removal
  only touches entries recognisably ours.
  The user has a seat: `MODERATOR_ID` (`"__moderator__"`) is seeded into the
  members map at construction — never joins or leaves, is excluded from
  `members_info()` (the renderer roster) but present in `peers()` (MCP
  `list_peers`), takes no inbox pushes, and cannot be `leave`d. The Discussion
  tab's composer sends through `war_room_moderator_send`. Deliveries are also
  gated on user typing, not just pty output: `shouldDeferDelivery` holds a
  queue while a pane has an unsubmitted line (`dirty`, tracked from
  `onData` in `terminal-registry`) or was typed in within `TYPING_QUIET_MS`
  while focused. A held queue is never dropped — it re-arms every
  `HOLD_RECHECK_MS`, shows an in-pane pill plus a panel badge, and both
  "Deliver now" affordances release it by clearing the typing signal rather
  than bypassing the scheduler. There is deliberately no maximum hold.
- **Worktree-per-agent.** The composer's "Isolate features in git worktrees"
  toggle now provisions isolation upfront: every agent pane is created inside
  its own `<repo>.worktrees/<slug>` worktree on branch `swarm/<agent>-<n>`
  (plain Terminal panes stay at the repo root; a failed creation falls back
  to the repo root with a console warning, never blocking workspace
  creation). The `worktree.spawn/list/remove` MCP tools remain as the
  secondary path — mid-session delegation to new worker panes and
  agent-driven cleanup — still gated on the same toggle via `worktree_mode`
  in the terminal map. Removal refuses dirty worktrees and anything outside
  `<repo>.worktrees`; closing panes/workspaces never deletes worktrees;
  worktree directories are never renamed (agent session state is keyed by
  absolute path).
- **Claude Code status line.** `swarmterm --statusline` is a second entry point
  into the same binary, short-circuited in `main.rs` *before* the Tauri builder
  so no window/tray/single-instance/AppKit is touched. It prints one line: an
  `mcp` segment and a `ctx` segment (`statusline/render.rs` is pure and holds
  every state). "Connected" is proved by an axum middleware on `/mcp` that
  records each inbound bearer token (`mcp/clients.rs`) — `initialize` never
  reaches `SwarmtermMcpServer::caller`, so hooking the tool layer would miss the
  one request that matters; `/status` is registered *after* `.layer(...)` so the
  probe cannot stamp its own verdict. Membership is dropped in both
  `kill_terminal` and `read_loop`, so a same-id respawn starts at `mcp …`. The
  probe is hand-rolled HTTP/1.1 over `TcpStream` (300 ms) — no tokio runtime in
  a command Claude re-runs every render. The entry is merge-written into
  `~/.claude/settings.json` (NOT `~/.claude.json`) and a foreign `statusLine` is
  never touched in either direction. On Windows the recorded path uses forward
  slashes: Claude Code runs the command through Git Bash, which eats
  backslashes. **Dev builds defer** (`dev_defer.rs`): `settings.json` is shared
  with the installed app, so a debug build leaves it alone — install AND
  removal, default and account profiles — while one of our `--hook` /
  `--statusline` commands runs a different binary that still exists.
  Otherwise a `tauri dev` in a worktree repoints every Claude session at
  `target/debug/swarmterm.exe`, and cleaning up the worktree breaks each hook
  event. Entries pointing only at a dead binary are still overwritten (the
  repair). Release builds
  always reclaim their entries; Codex has a similar rule (`hook/codex.rs`, which skips whenever any entry of ours exists).
- **Native preview webviews.** The preview column is a per-terminal native
  child webview (`preview.rs`, label `preview-<terminalId>`, Tauri `unstable`
  feature for `add_child`). Invariant: a preview webview is visible iff
  BrowserColumn's placeholder div is mounted AND no overlay is open
  (`lib/overlay-watch.ts`) — native views paint over ALL DOM, so anything less
  puts a web page on top of your menus. State flows one way: commands drive
  the webview, `preview:state` events update `browser-store` (serde camelCase
  in lockstep with `src/tauri/preview.ts`); never navigate from an event.
  Back/forward are `eval("history.back()")` — there is no native API. Popups
  are denied and navigate the same preview in place. Webviews close on
  terminal death in `kill_terminal` AND `read_loop` (belt-and-braces, like the
  War Room auto-leave).
- **Auto-update.** Disabled in GN. The tag-triggered Windows release workflow
  publishes standalone installers and checksums without updater artifacts.
  `scripts/release/publish.mjs` deliberately refuses the current configuration.
  See `docs/release-process.md`; do not restore upstream update endpoints.
- **Anonymous telemetry is compile-time gated.** `analytics.rs` sends a GA4
  Measurement Protocol `app_open` + 5-minute heartbeat, but only when
  `SWARMTERM_GA_MEASUREMENT_ID` / `SWARMTERM_GA_API_SECRET` were in the env
  when **cargo compiled** (`option_env!` — the release scripts export them
  from `.env.release`). Dev and source builds are no-ops; don't add runtime
  key lookups, and never send more than version + OS (the user-guide
  Telemetry section is the contract).
- **Saved workspaces.** Welcome lists up to 24 local snapshots. `saved-workspaces`
  serializes structure only; `saved-workspace-sync` debounces meaningful changes
  and flushes on close/quit. Restore verifies directories and exact session ids,
  then allocates fresh runtime ids. Forget detaches a live instance from saving.
  Never persist prompts, terminal output, startup commands or unsaved buffers.
  `agent:session` hooks update `sessionId`, independently of `resumeSessionId`
  (changing startup options on capture would respawn a live PTY). Rust checks
  agent and PTY generation before emitting. Codex hook definitions are additive;
  preserve user hooks, hook feature settings and trust. Supported Codex panes
  use `--no-daemon` to keep the hook environment specific to each pane.
- **Session resume.** The composer's "Resume sessions" list is read live from
  the CLIs' own stores (`sessions/` module scans Claude/Codex JSONL; OpenCode
  goes through `opencode session list --format json`). Discovery is fail-open
  (error ⇒ empty, never blocks Create); session ids are regex-validated in
  `lib/resume-command.ts` before they reach a shell line; resume panes spawn
  at the session's recorded cwd and are exempt from worktree provisioning.
- **Voice pipe (SWA-12).** `src-tauri/src/voice/`: a named pipe (current-user
  DACL, `first_pipe_instance`) plus `voice-endpoint.json` in the local app
  data dir (pipe, per-launch token, pid) — not a route on the MCP server,
  which browsers can reach. Three ops only (`begin`/`insert`/`cancel`),
  never a command. `begin` asks the renderer who owns the keyboard
  (`lib/voice-focus.ts`, 300 ms) and pins `{terminalId, spawn_id}`
  single-use; `insert` hands the text to the renderer, which writes ONLY via
  `write_terminal_checked` (spawn_id check AND enqueue under the `terminals`
  lock) and reports the ACK back — the ACK means queued for that generation,
  not yet written to the pty. Draft rules live in `lib/voice-insert.ts` /
  `voice-delivery.ts`: sanitise before framing, plain shells flatten
  CR/LF/TAB, blocked panes refused, reset the IME segment THEN mark dirty,
  Enter is a separate delayed write re-checked against the typing stamp.
  The source logic is pipe-independent so an in-process speech source can
  call it directly. SWA-40: envelope stays `v:1`; `hello` (first request
  only) negotiates `proto`/capabilities per connection, unknown ops answer
  `unknown-op` (1.9.0: `bad-request`, clients treat both as proto 1).
  `indicator` = the client holds ONE connection per dictation; the pin is
  bound to it and drives the pane pill (`voice:indicator`, keyed by pin).
  Every server-side pin end goes through `finish` (pill off + `cancelled`
  push with reason); only `user` means discard, anything else keeps the
  client's clipboard fallback. Answers and pushes share a per-connection
  writer task — never write to the pipe from the reader. `apply()` only
  restarts the endpoint on an on/off switch.
  Lock order is `pins` → `terminals` (`begin` re-checks the spawn_id under
  the pins lock): never call `voice::drop_terminal` while holding
  `terminals`.
- **Built-in speech (SWA-38, `docs/adr/0001`).** `voice/speech/` records
  (cpal, own thread — dropping the stream frees the mic) and transcribes
  (whisper-rs, CPU, context cached per model) as an in-process client of
  `voice::handle`: `Conn::in_process` = registered connection with
  `indicator`, so pins, pill, draft rules and `cancelled` pushes are
  buzzkey's. It never takes pins/`terminals` locks itself. One dictation at
  a time (`active` spans begin → insert answer). Models: fixed catalog in
  `speech/model.rs` (URL + SHA-256), `.part` file renamed only on a hash
  match. Build: bindgen needs libclang (`LIBCLANG_PATH`; CI uses the
  runner's LLVM — whisper-rs-sys's bundled bindings are Linux-only), and
  `src-tauri/.cargo/config.toml` forces `-O2` (the cmake crate drops it for
  MSVC → 7x slower) plus an AVX2 baseline. After changing those flags run
  `cargo clean -p whisper-rs-sys` — its build script does not rerun on env
  changes. Debug builds replay `SWARMTERM_DICTATION_WAV` instead of the mic
  (testlab).
- **File watcher: one recursive watch per root (SWA-53).** `files/watch.rs`
  watches the context root with `RecursiveMode::Recursive`, never one watch
  per folder. On Windows every watch is an open directory handle, and Windows
  refuses to rename/move a folder while a handle is open anywhere BELOW it
  (WinError 5, FILE_SHARE_DELETE doesn't help) — per-folder watches locked
  the whole workspace against git/npm/cargo/build-tool temp-dir renames and
  held 100k+ handles. `ignored()` filters events by their PARENT instead of
  pruning folders; git metadata watches and explicitly requested files pass
  regardless. notify 8 drops a ReadDirectoryChangesW buffer overflow
  silently, so a burst (`RESCAN_BURST` raw events) schedules one trailing
  `rescan` change after `RESCAN_QUIET`; the explorer then reloads every
  loaded folder and documents re-check disk. Only the root itself stays
  non-renameable (user-guide Known limits).
- **App shortcut gate contract.** Window-level app shortcuts matched by
  `matchAppShortcut` must go through TWO places: `App.tsx`'s keydown handler
  (dispatch) AND `terminal-registry.ts::attachCustomKeyEventHandler` (gate that
  suppresses the combo toward the pty, since xterm ignores `preventDefault` and
  would otherwise write a control byte like `^F`/`^B` into the shell on non-mac).
  Omit either and the shortcut either doesn't work or leaks bytes to the shell.

## Dev workflow

New features follow a spec-first flow: brainstorm a short design doc, turn it
into an implementation plan, then build it with TDD (`lib/` tests first).
Outside contributions follow `CONTRIBUTING.md` — design discussion in an issue
first for anything non-trivial.

## Docs map

- `README.md` — short user-facing intro (English): the pitch as three core
  ideas, install, first run. No feature walkthrough (that's the user guide) and
  no architecture or folder tree — that lives here. Screenshots are placehold.co
  placeholders until real ones land; `docs/images/README.md` has the shot list.
- `docs/user-guide.md` — the detailed end-user guide: feature walkthrough,
  shortcuts, troubleshooting, known limits.
- `CONTRIBUTING.md` — how to build, test, and submit changes; the CI contract.
- `docs/manual-smoke-tests.md` — release smoke checklist.
- `docs/release-process.md` — the Windows release workflow: version bump,
  annotated tag, checks, installer, checksums and GitHub publication.
  Start here when releasing.
- `docs/release-macos.md` — retained upstream signing reference; GN does not
  support or publish macOS releases.
- `docs/release-windows.md` — the Windows NSIS build: one-time machine setup,
  `npm run release:win`, and the SmartScreen (unsigned build) story.
- `docs/war-room-demo.md` — scripted War Room demo (Claude Code × Codex).

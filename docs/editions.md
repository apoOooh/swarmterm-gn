# Editions: Standard and Corp

Swarmterm GN is built in two editions from the same source and released together:

- **Swarmterm GN** (Standard): the full app for individual developers.
- **Swarmterm GN Corp**: the same app for companies with strict security rules. Its restrictions are compiled
  into the program. No setting, file or registry value can switch them off, and the voice companion installer and
  the speech model download are not part of the program at all.

Both editions read the same [administrator policy](admin-policy.md), so an organisation can lock more features in
either one.

**What the Corp locks are, and are not.** The Corp bypass lock is a guard against mistakes: it refuses the launch
flags it recognises for the agents it knows. It is not a security boundary: a user can still type an agent's bypass
flag into a shell pane or start an agent outside Swarmterm. For a corporate deployment the real controls are:

1. the **HKLM administrator policy** ([admin-policy.md](admin-policy.md)), which applies to both editions;
2. the **agents' own managed settings**, required for corporate deployment: Claude Code managed settings with
   `"permissions": { "disableBypassPermissionsMode": "disable", "disableAutoMode": "disable" }`
   (removes Bypass and Auto mode), Codex managed `requirements.toml`;
3. **AppLocker or WDAC** rules that allow only the Corp installer's hash or install path, so users cannot run a
   swapped executable or the Standard edition.

## Which one to choose

| You are… | Install |
|---|---|
| A developer on your own machine | **Swarmterm GN** |
| An organisation whose security review requires that agents cannot bypass their approval prompts, drive other panes, or fetch extra programs at runtime, even if a user changes settings | **Swarmterm GN Corp** |
| An organisation that only wants to lock some features centrally | Either. Standard plus the [administrator policy](admin-policy.md) is enough when Group Policy or Intune reliably sets HKLM. Corp also holds when no policy is deployed (for example on a machine outside the domain). |

## Feature by feature

Legend:

- **Compiled out**: the code is not in the Corp program. The Settings section is hidden.
- **Locked (built in)**: the code is there, but a compiled-in lock refuses it. Settings lists it under
  "Swarmterm GN Corp" and greys out the controls.
- **Policy-lockable**: available by default, an administrator can lock it with the registry value named.
- **Same**: identical in both editions.

| Feature | Standard | Corp |
|---|---|---|
| Bypass/YOLO launch modes (`--dangerously-skip-permissions`, `--yolo`, …) | Available, confirmed on selection; lockable (`DisableBypassModes`) | **Locked (built in)**. Panes whose launch line switches an agent's approvals or sandbox off are refused. |
| War Room `execute` by agents (run a prompt in another pane) | Off by default, user can allow it; lockable (`DisableWarRoomExecute`) | **Locked (built in)**. Probes and your own War Room messages still work. |
| buzzkey voice companion: install, update checks, update toast, auto-update, and its Settings → Voice section (start, quit, autostart) | Available on click; lockable (`DisableCompanion`) | **Compiled out** (also locked by `DisableCompanion`); the section is hidden. The voice pipe itself stays: Corp writes its endpoint file to `%LOCALAPPDATA%\com.apooooh.swarmterm.gn.corp\voice-endpoint.json`, so a separately installed buzzkey connects only if it looks for that identifier (not verified with current buzzkey releases). |
| Speech model download for built-in dictation | Available on click; lockable (`DisableModelDownload`) | **Compiled out** (also locked by `DisableModelDownload`). Models an administrator copies to `%LOCALAPPDATA%\com.apooooh.swarmterm.gn.corp\models\` (file names as in the Standard edition, for example `ggml-small-q5_1.bin`) are used. |
| Environment filter (no secret-looking variables in panes and routines) | On by default, user can switch it off; lockable (`EnvPolicy`) | **Locked (built in)** in `default` mode: cannot be switched off, the user's own allow list is ignored. `EnvPolicy=strict` and `EnvAllow` still apply. |
| War Room as a whole (rooms, probes, `read_peer`, all `war_room.*` tools) | Policy-lockable (`DisableWarRoom`) | Policy-lockable (`DisableWarRoom`); not compiled in (decision 2026-10-29) |
| Command routines ("Shell command" kind) | Policy-lockable (`DisableRoutineCommands`) | Policy-lockable (`DisableRoutineCommands`) |
| `worktree.spawn` MCP tool | Policy-lockable (`DisableWorktreeSpawn`) | Policy-lockable (`DisableWorktreeSpawn`) |
| Web preview (embedded browser) | Policy-lockable (`DisablePreviewBrowser`) | Policy-lockable (`DisablePreviewBrowser`) |
| Local MCP server (`127.0.0.1`, per-pane token) | Policy-lockable (`DisableMcp`) | Policy-lockable (`DisableMcp`) |
| Terminals, workspaces, Git panel, files and editor, notifications, War Room probes, status line, built-in speech with local models, spoken announcements, terminal host, process priority | Same | Same |
| Telemetry, self-update | None | None |

Why routines, `worktree.spawn`, the preview and MCP stay available in Corp: they are core workflow, run only what
the user starts or what an agent the user launched asks for in its own pane, and they do not fetch code from the
internet. Organisations that do not want them lock them with the policy value; nothing in the Corp build has to
change for that.

## Installers and identity

| | Standard | Corp |
|---|---|---|
| Release asset | `Swarmterm.GN_<version>_x64-setup.exe` | `Swarmterm.GN.Corp_<version>_x64-setup.exe` |
| SBOMs | `sbom-rust.cdx.json`, `sbom-rust-host.cdx.json`, `sbom-npm.cdx.json` | same files (the `corp` feature adds no dependencies) |
| App identifier | `com.apooooh.swarmterm.gn` | `com.apooooh.swarmterm.gn.corp` |
| Product name, window title, Start menu | Swarmterm GN | Swarmterm GN Corp |
| Install mode | per user, no administrator rights, `%LOCALAPPDATA%\Swarmterm GN\` | per machine, needs administrator rights, `%ProgramFiles%\Swarmterm GN Corp\` (not writable by users) |
| Settings and saved workspaces | `%APPDATA%\com.apooooh.swarmterm.gn\` | `%APPDATA%\com.apooooh.swarmterm.gn.corp\` |
| Registry policy key | `Software\Policies\SwarmtermGN` | same key |

All assets are listed in `SHA256SUMS.txt` on the release.

Both editions can be installed **side by side**: different identifiers mean separate installs, separate settings and
separate single-instance locks. Consequences:

- Switching from Standard to Corp does **not** carry settings or saved workspaces over. Recreate them, or copy the
  files from the Standard folder above into the Corp folder while both apps are closed.
- Uninstall Standard if users should only have Corp; installing Corp does not remove it.
- Both editions write the same per-user agent integrations (the Swarmterm MCP entry, Claude Code status line and
  hooks). The app that started last owns them; run one edition at a time.

## How the administrator policy applies

Both editions read `HKLM\Software\Policies\SwarmtermGN` and then HKCU once at start ([details](admin-policy.md)).
In Corp the compiled-in locks are combined with the registry values: a value can **add** locks (for example
`DisableMcp=1` or `EnvPolicy=strict`) but never lift a built-in one. `DisableCompanion=0` in the registry changes
nothing in Corp. Settings → top section shows which locks are built in and which come from the administrator. A
refusal message names the edition ("not available in Swarmterm GN Corp") for built-in locks and the administrator
for registry ones.

## Building

| Command | Builds |
|---|---|
| `npm run tauri build` | Standard installer |
| `npm run tauri:build:corp` | Corp installer (`--config src-tauri/tauri.corp.conf.json`, Cargo feature `corp`, `vite --mode corp`) |
| `npm run tauri:build:corp:no-speech` | Corp without the speech engine (no LLVM needed), for local checks |
| `npm run test:rust:corp` | Rust unit tests with the `corp` feature |

The edition is fixed at compile time: the Rust feature `corp` sets the locks and removes the download code, and
`vite --mode corp` builds the renderer that hides those sections. Either side reporting Corp is enough for the
renderer to hide them.

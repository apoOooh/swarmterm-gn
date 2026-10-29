# Privacy policy

Swarmterm GN, version 1.25.4 and later. Last updated: 2026-10-29.

Swarmterm GN is a desktop application you install and run on your own
Windows computer. The project offers no online service, no website and no
user accounts. This document describes what the application stores, what it
sends over the network, and when.

## Summary

- **No telemetry.** The application sends no usage data, analytics, crash
  reports or identifiers to the project or anyone else.
- **No accounts.** The project does not register, identify or track users.
- **No data collected by the project.** Nothing you do in the app reaches the
  project maintainers. The only way information reaches them is if you choose
  to post it, for example in a GitHub issue.
- **No self-update.** The application never checks for or installs its own
  updates.
- **Local data stays local** (see below), except for the specific, listed
  network connections, which are either started by you or concern the
  optional buzzkey companion.

## Data stored on your computer

All files below belong to your Windows user account. The application
identifier is `com.apooooh.swarmterm.gn`.

| Data | Location | Source |
|---|---|---|
| Settings, saved workspace layouts, recent folders, prompt library, routines, shortcuts, appearance | WebView2 local storage under `%LOCALAPPDATA%\com.apooooh.swarmterm.gn\` | `src/lib/saved-workspaces.ts`, `src/store/routine-store.ts`, `src/store/prompt-library-store.ts` and other `localStorage` users in `src/lib/` |
| Account profiles (name, agent, config folder path; no credentials) | `%APPDATA%\com.apooooh.swarmterm.gn\agent-accounts.json` | `src-tauri/src/accounts.rs` |
| Terminal host and voice settings, Swarmterm MCP opt-outs | `%APPDATA%\com.apooooh.swarmterm.gn\terminal-host.json`, `voice-settings.json`, `swarmterm-mcp-disabled.json` | `src-tauri/src/host_client/mod.rs`, `src-tauri/src/voice/mod.rs`, `src-tauri/src/lib.rs` |
| Local deletion history (copies of files you delete in the file explorer) | `%APPDATA%\com.apooooh.swarmterm.gn\local-history\` | `src-tauri/src/lib.rs`, `src-tauri/src/files/history.rs` |
| Speech recognition models you download | `%LOCALAPPDATA%\com.apooooh.swarmterm.gn\models\` | `src-tauri/src/voice/speech/mod.rs` |
| Voice endpoint description (pipe name, per-launch token, process id) | `%LOCALAPPDATA%\com.apooooh.swarmterm.gn\` | `src-tauri/src/voice/pipe.rs` |
| Pasted clipboard images, annotated image copies, clipboard media | `%TEMP%\swarmterm-paste\`, `%TEMP%\swarmterm-marked\`, `%TEMP%\swarmterm-clipboard\` | `src-tauri/src/paste_image.rs`, `src-tauri/src/marked_media.rs`, `src-tauri/src/clipboard_media.rs` |

Saved workspaces store structure only (folders, pane layout, agent choice,
session ids). Terminal output, prompts, startup commands and unsaved editor
buffers are not saved. The application writes no log files of its own.

The application reads, but does not copy or send, the agent CLIs' own files:
session lists for resuming conversations and, for the Accounts panel, login
state and plan from the CLI credential files. Tokens are parsed in memory and
never shown or stored (`src-tauri/src/account_status.rs`).

To connect agents to the app, Swarmterm GN adds its own entries to the agent
CLIs' configuration in your user profile: the Swarmterm MCP server, the status
line and lifecycle hooks (for example `~/.claude.json`,
`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.codex/hooks.json`).
Settings → MCP switches the MCP entry off per agent and profile.

Uninstalling the app does not remove these files; delete the folders above to
remove them.

## Network connections made by the application

The table lists every connection the application itself opens. Nothing in it
contains telemetry or personal data beyond what any HTTPS request carries
(your IP address and a user agent).

| Connection | When | Default |
|---|---|---|
| Local MCP server on `127.0.0.1` (random port). Panes and their agents connect to it with a per-pane token. It is not reachable from other computers. | Always, while the app runs | On (`src-tauri/src/mcp/mod.rs`) |
| Status line and hook commands call the same local server on `127.0.0.1` | When an agent CLI runs them | On (`src-tauri/src/statusline/probe.rs`, `src-tauri/src/hook/post.rs`) |
| `api.github.com`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`: lists and downloads releases of the buzzkey voice companion (`apoOooh/buzzkey`) | When you click Check or Install in Settings → Voice; and, only if buzzkey is installed and connected, one release check 20 seconds after start and then every 24 hours | Install: off until you click. Update check: only with buzzkey connected. Automatic install: off (`src-tauri/src/voice/companion/`, `src/lib/buzzkey-update.ts`) |
| `huggingface.co` (`ggerganov/whisper.cpp`): downloads a speech recognition model | When you click to download a model in Settings → Voice | Off (`src-tauri/src/voice/speech/model.rs`) |
| Web preview: loads the address you or an agent in your pane open; text that is not an address becomes a Google search (`www.google.com`) | When a preview is opened | Off until opened (`src-tauri/src/preview.rs`, `src/lib/web-url.ts`) |
| Images linked from Markdown or HTML files you preview | When you open such a preview | Follows the files you open |
| Links you click (documentation, file links) open in your default browser | On click | Off |

Downloads of buzzkey are checked against a signature and SHA-256 hashes before
installation; see [docs/security-model.md](docs/security-model.md).

The application does not contact the project, upstream projects or any
analytics, advertising or update service.

## Agent CLIs and other programs

Swarmterm GN starts programs you choose in its terminal panes, such as
Claude Code, Codex, OpenCode or your own shell commands. Those programs make
their own network connections, for example to Anthropic or OpenAI, under their
providers' terms and privacy policies. The same applies to MCP servers you add
through the MCP catalogue, the Microsoft WebView2 runtime that renders the
interface, and Windows itself. Swarmterm GN does not control these
connections.

Panes do not inherit secret-looking environment variables (tokens, keys,
passwords) from the application by default. See Settings → Terminal →
Environment.

## Changes and contact

Changes to this policy are recorded in this file's Git history and noted in
the release notes. Questions: open an issue at
<https://github.com/apoOooh/swarmterm-gn/issues>. Security reports: see
[SECURITY.md](SECURITY.md).

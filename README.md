<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png">
  <img src="docs/images/logo-light.png" alt="Swarmterm GN" width="96" height="96">
</picture>

# Swarmterm GN

**One window for a whole swarm of AI coding agents.**

Real split terminals, one git worktree per agent, and an app your agents can drive themselves. Windows x64.

[![Latest release](https://img.shields.io/github/v/release/apoOooh/swarmterm-gn)](https://github.com/apoOooh/swarmterm-gn/releases/latest)
[![CI](https://github.com/apoOooh/swarmterm-gn/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/apoOooh/swarmterm-gn/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

<!-- IMAGE: upgrade to docs/images/hero.gif when a ~20s tour is recorded; see docs/images/README.md -->
<img src="docs/images/hero.png" alt="Swarmterm GN with several agent panes, the file explorer and the right panel" width="100%">

[Features](#features) · [Install](#install) · [Quick start](#quick-start) · [Security and privacy](#security-and-privacy) · [User guide](docs/user-guide.md)

</div>

---

## Features

**Terminals and workspaces**
- Workspaces of real split terminal panes (ConPTY), with live titles, activity and agent-state dots, broadcast typing and zoom.
- Saved workspaces and templates restore layouts, folders and agent sessions; panes can keep running in a separate terminal host across app restarts (optional).
- Close to tray; everything keeps running until you quit.

**Agents**
- Agent catalogue: Claude Code, Codex, OpenCode, Copilot, Qwen Code, Gemini, Amp, Cursor and more, each with launch modes (from confirming to bypass) and session resume.
- Worktree isolation: each agent pane works in its own git worktree and branch.
- Account profiles: several Claude Code or Codex logins side by side, with plan and remaining budget.
- Prompt library and routines: send saved prompts to agents, or run agents and shell commands on a schedule.
- Notifications and a bell for agents that finish or wait for input.

**Agents drive the app (MCP)**
- Every pane is connected to a local Swarmterm MCP server: agents open a web preview, spawn and remove worktrees, and talk to each other.
- War Room: panes you drag in can message each other or hand over prompts, with you as moderator.
- MCP catalogue: add Playwright, GitHub, Context7 and other servers to an agent profile.

**Right panel and files**
- Web preview column per terminal, with address bar and history.
- Git panel: worktree, branch, changes, inline diff and merge check for the focused pane.
- File explorer and editor that follow the focused terminal, Markdown/SVG/HTML previews, local deletion history.
- Media panel: images from pane output as thumbnails, large viewer, annotation, drag into panes.
- Seven dark themes from Astera.

**Voice and system**
- Dictation into panes via the buzzkey companion or built-in offline speech recognition (whisper.cpp).
- Spoken announcements when agents finish (Windows voices, opt-in).
- Builds stay responsive: pane processes run in Job Objects with a lower priority class and optional CPU cap.

The [user guide](docs/user-guide.md) covers every feature, shortcut and setting.

## Install

1. Download `Swarmterm.GN_<version>_x64-setup.exe` and `SHA256SUMS.txt` from [Releases](https://github.com/apoOooh/swarmterm-gn/releases).
2. Check the hash: `Get-FileHash .\Swarmterm.GN_*_x64-setup.exe` must match `SHA256SUMS.txt`.
3. Run the installer. It is not code-signed yet, so Windows SmartScreen may warn about an unknown publisher.

Requirements: Windows 10/11 x64 with the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/), plus the agent CLIs you want to use (`claude`, `codex`, `opencode`). Missing CLIs show as disabled.

The app never updates itself. Install a new release over the old one, or distribute it with your IT tools.

## Quick start

1. Pick a project folder on the Welcome screen.
2. Choose the number of panes and assign agents (Claude Code, Codex, OpenCode or a plain terminal) and their launch mode.
3. Switch on **Isolate features in git worktrees** to give every agent its own branch.
4. Press `Ctrl+Enter`. The right panel holds the preview, Git, Media and the War Room.

Layouts save automatically under **Saved workspaces**. Closing the window hides the app to the tray; tray → **Quit** exits.

## Security and privacy

- **No telemetry, no accounts, no self-update.** The app sends no usage data and never downloads updates for itself.
- **Network use is listed** in [PRIVACY.md](PRIVACY.md): a local MCP server on `127.0.0.1`, and downloads (buzzkey, speech models) only when you ask for them.
- **Secrets stay out of panes:** by default panes do not inherit secret-looking environment variables (Settings → Terminal → Environment).
- **Launch modes are explicit:** agents start in their confirming mode unless you pick a bypass mode. Bypass modes are confirmed before launch and marked on the pane.
- **War Room execute** (handing a peer a prompt to run) is off by default.
- **Verified downloads:** the buzzkey companion is installed only after a signature and hash check; speech models are hash-checked.
- **Supply chain:** CI checks advisories and licences (`cargo deny`, `npm audit`); each release ships CycloneDX SBOMs.
- **Administrator policy:** organisations can lock features (bypass modes, War Room execute, MCP, downloads, routines, preview, environment filter) through Group Policy or Intune; see [Administrator policy](docs/admin-policy.md). Planned: a `corp` build variant.

Documents: [Privacy policy](PRIVACY.md) · [Terms of use](TERMS.md) · [Security policy](SECURITY.md) · [Security model](docs/security-model.md) · [Project decisions](docs/decisions.md)

## Build from source

Node.js 24, npm and stable Rust on Windows:

```powershell
git clone --branch dev https://github.com/apoOooh/swarmterm-gn.git
cd swarmterm-gn
npm ci
npm run tauri:dev:no-speech   # run without the built-in speech engine (no LLVM needed)
npm run tauri build           # installer; the speech engine needs LLVM and CMake
```

Prerequisites, tests and contribution rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## Origin and status

Swarmterm GN is an independent project. It started as a fork of [duongducnguyen/swarmterm](https://github.com/duongducnguyen/swarmterm) and added the [Astera](https://github.com/parsingk/Astera) themes and file tools, then grew on its own. It is no longer based on or synced with upstream; upstream's website, policies and releases do not apply to Swarmterm GN.

Development happens on `dev`; releases are tagged on `main` ([release process](docs/release-process.md), [changelog](CHANGELOG.md)). Known limits are in the [user guide](docs/user-guide.md#known-limits). Issues: [GitHub issues](https://github.com/apoOooh/swarmterm-gn/issues).

## Licence

[GPL-3.0-only](LICENSE). Third-party components keep their licences: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), plus SBOMs attached to each release.

<sub>Built on <a href="https://tauri.app">Tauri</a>, <a href="https://xtermjs.org">xterm.js</a> and <a href="https://github.com/wez/wezterm/tree/main/pty">portable-pty</a>.</sub>

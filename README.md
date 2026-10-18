<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png">
  <img src="docs/images/logo-light.png" alt="Swarmterm" width="96" height="96">
</picture>

# Swarmterm GN

**One window for a whole swarm of AI coding agents.**

Real split terminals, one git worktree per agent — and an app your agents can drive themselves.

<!-- IMAGE: upgrade to docs/images/hero.gif when a ~20s tour is recorded — see docs/images/README.md -->
<img src="docs/images/hero.png" alt="Swarmterm — one window for a whole swarm of AI coding agents" width="100%">

[![CI](https://github.com/apoOooh/swarmterm-gn/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/apoOooh/swarmterm-gn/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

</div>

---

## What it is

Swarmterm GN is a **Windows x64** fork of [Duong Duc Nguyen's Swarmterm](https://github.com/duongducnguyen/swarmterm). It adds all seven [Astera](https://github.com/parsingk/Astera) themes and a terminal-linked file explorer, editor, Markdown/media previews and deletion history. Click a terminal in the left sidebar: **Files** follows its project or worktree. Running shells remain alive while you edit files or switch themes.

See [the migration notes](docs/astera-port.md) for the source mapping, supported operations and verification. `dev` is the fork's integration branch; `main` retains the upstream baseline. Screenshots below show the original Swarmterm interface.

Running **one** coding agent in a terminal works anywhere. Running **five** is where ordinary terminals fall apart: tabs hide who is doing what, agents trample each other's edits, and you become the relay pasting prompts and URLs between windows.

Swarmterm is a native desktop app (Tauri 2 + Rust, real PTY terminals, a VS Code-flavoured interface) built around three ideas:

**See the whole swarm.** A workspace is one window of real split terminal panes — live titles, an activity dot on any pane still producing output, and broadcast typing for when five agents should hear the same thing at once.

<img src="docs/images/split-panes.png" alt="Broadcast ON — one line typed into three agent panes at once, the dev-server pane left out" width="100%">

**Keep the work separate.** Flip one switch and every agent pane is born inside its own git worktree, on its own branch — separate, reviewable diffs from the very first edit, with a git panel to read them without leaving the app.

<img src="docs/images/git-worktrees.png" alt="The Git panel — one swarm/* worktree per agent, changed files and an inline diff" width="100%">

**Agents are users of the app, too.** Every pane is connected to Swarmterm itself, so agents don't just run *in* it: they put a live web preview beside their own pane, spin up isolated worktrees to delegate subtasks, and discuss work with each other — with you moderating.

<p>
  <img src="docs/images/web-preview.png" alt="An agent opened its dev server in the preview column beside its own pane" width="49.5%">
  <img src="docs/images/war-room.png" alt="The War Room — agents debating a fix, with the user moderating and handing out tasks" width="49.5%">
</p>

Everything else hangs off those three ideas. The full tour — panes, broadcast, session resume, the web preview, the War Room, the status line, shortcuts, troubleshooting — lives in **[the user guide](docs/user-guide.md)**.

---

## Install & run

Download the Windows x64 installer from [this fork's releases](https://github.com/apoOooh/swarmterm-gn/releases), or build from source. It uses the application name **Swarmterm GN** and identifier `com.apooooh.swarmterm.gn`. Upstream automatic updates are disabled so an upstream release cannot replace the fork. Install whichever agent CLIs you plan to use (`claude`, `codex`, `opencode`) — anything missing appears disabled. The initial installer is unsigned; Windows SmartScreen may show an unknown publisher warning. Release assets include SHA-256 checksums. macOS and Linux are not supported by this fork.

### Build from source

Use Node.js 24, npm and a stable Rust toolchain:

```powershell
git clone --branch dev https://github.com/apoOooh/swarmterm-gn.git
cd swarmterm-gn
npm ci
npm run tauri dev                    # develop / just use it
npm run tauri build                  # installer / app bundle
```

Windows prerequisites: the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/), Microsoft C++ Build Tools, CMake and LLVM (for libclang; set `LIBCLANG_PATH` to its `bin` folder if it is not installed under `C:\Program Files\LLVM`) — the built-in speech recognition compiles whisper.cpp. Without LLVM and CMake, build without it: `npm run tauri:dev:no-speech`, `npm run test:rust:no-speech`, or pass `--no-default-features` to `cargo`/`tauri build` (only built-in dictation is missing then). See [Tauri prerequisites](https://tauri.app/start/prerequisites/). The first build compiles the Rust side and takes a few minutes. `npx tauri build --no-bundle` compiles the desktop executable without creating installers or opening the app. Tagged Windows releases are built and published by [GitHub Actions](docs/release-process.md).

For checks, run `npm test`, `npm run build`, and `npx playwright install chromium && npm run test:e2e`. Browser tests are headless and use an in-memory native bridge. From `src-tauri/`, run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`.

---

## First run

Swarmterm opens on the composer: pick a folder, choose how many terminals, assign **Claude Code**, **Codex** or **OpenCode** to some of them, switch on **Isolate features in git worktrees**, and press `⌘/Ctrl + Enter`. Your panes open with the agents already starting up; the right panel gives you the web preview, the git view, and the War Room.

Workspace layouts save automatically and appear under **Saved workspaces** on Welcome. Claude Code and Codex hooks record each pane's conversation for reopening; review Codex's hooks through `/hooks`. Terminal output and unsaved editor buffers are not saved. **Closing the window hides the app to the tray** with everything still running; tray → **Quit** is what actually exits.

From here, the **[user guide](docs/user-guide.md)** covers the rest.

---

## Status

The Astera port adds seven dark themes, file management and editing to the upstream 1.0.4 baseline. Current limits:

- you need terminal scrollback or unsaved editor buffers to survive a restart;
- the embedded text editor supports **UTF-8 files up to 1 MiB**; binary and larger files are read only;
- native file clipboard and media codecs need platform smoke tests; Linux/macOS CI checks compilation and Rust tests;
- deletion history covers **explorer deletions**, not deletions made by shell commands.

The full list lives in the guide's [known limits](docs/user-guide.md#known-limits).

---

## Contributing & community

Fork issues belong in [swarmterm-gn/issues](https://github.com/apoOooh/swarmterm-gn/issues). [`CONTRIBUTING.md`](CONTRIBUTING.md) explains the upstream architecture and contribution conventions. Swarmterm is free software under [GPL-3.0](LICENSE); Astera source and bundled fonts retain their notices in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Source builds without analytics environment keys do not send launch telemetry.

---

<sub>Built on <a href="https://tauri.app">Tauri</a>, <a href="https://xtermjs.org">xterm.js</a> and <a href="https://github.com/wez/wezterm/tree/main/pty">portable-pty</a>; interface styled after VS Code. Working on Swarmterm itself? Start with <a href="CONTRIBUTING.md"><code>CONTRIBUTING.md</code></a>, <a href="CLAUDE.md"><code>CLAUDE.md</code></a>, and the release checklist in <a href="docs/manual-smoke-tests.md"><code>docs/manual-smoke-tests.md</code></a>.</sub>

# 0001: Terminal host process that outlives quit and update

**Status:** Proposed

## Context

Every PTY lives inside the app process. `ManagedTerminal` (`src-tauri/src/pty.rs`)
owns the ConPTY master, the writer thread (`PtyInput`), the reader/flusher pair
and a Windows Job Object created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.

- **Close window**: hides to the tray, so PTYs survive. This case is already covered.
- **Quit** (`tray::quit` → `quit_blocking`): drains the `terminals` map and
  calls `shutdown()` on each entry. Each shell gets a graceful close
  (`CTRL_CLOSE_EVENT`), then a hard terminate after `KILL_GRACE` (3 s).
- **Crash, task kill, installer replacing the exe**: no `quit_blocking` runs.
  The job handles drop at process exit and kill-on-close tears every tree
  down hard. Claude Code counts that as a failed fullscreen start.
- **Restart**: no reattach exists. The renderer spawns a fresh PTY per pane.
  Agent conversations resume via `--resume <sessionId>` (`lib/templates.ts`,
  saved-workspace restore). Scrollback, running builds, dev servers and
  plain-shell state are lost.

Auto-update is disabled in GN today. Once it is enabled, every update would be
a hard kill of all running agents.

The app process also owns everything keyed on the live `terminals` map:

- MCP bearer auth (`mcp/server.rs`: a token is valid iff the pane's PTY is live)
- `worktree_ctx`, client tracking, `/status` and `/hook`, `agent:session`
- War Room liveness (`mcp/tools/peers.rs`)
- Voice pins (`voice/mod.rs`, `write_terminal_checked`)

## Decision

Move PTY ownership into a separate sidecar binary, `swarmterm-host.exe`. The
app becomes its client.

**Host owns:**

- `ManagedTerminal`, `PtyInput`, reader, flusher and Job Objects, moved
  from `pty.rs` largely unchanged
- generation identity (`spawn_id`) and graceful `shutdown` with `KILL_GRACE`
- a bounded output ring buffer per pane (default 1 MiB) for replay on attach

**App keeps:** MCP server, War Room, Voice, preview webviews, status line and
hooks, the renderer. It holds a mirrored terminal registry (id, `spawn_id`,
`pid`, agent, cwd, `worktree_mode`, `repo_root`) that the host updates by
event. Every existing liveness check reads the mirror, so the rule "a token
authorises only while its PTY is live" is unchanged.

**Transport:** a named pipe with a current-user DACL, `first_pipe_instance`,
remote clients rejected, and a per-launch token in
`%LOCALAPPDATA%\<app-id>\host-endpoint.json`. This is the pattern proven by
`voice/pipe.rs`. One connection per app instance carries requests, events
and data frames through a single writer task.

**Protocol:**

- Envelope `v:1` with a `hello` op that negotiates `proto` and capabilities,
  as in SWA-40. Unknown ops answer `unknown-op`.
- Requests: `create`, `write`, `write_checked` (generation check plus
  enqueue, atomic in the host), `resize`, `kill`, `list`, `attach` (returns
  the ring-buffer replay, then live `data`).
- Events: `data`, `exit` (still after all `data`), `spawned`, `removed`.
- Output bytes travel as binary frames, not JSON, to keep the 4 ms / 64 KB
  batching cheap.

**MCP URL stability:** `SWARMTERM_MCP_URL` is baked into each shell's env, so
the port must survive an app restart. The host persists the port the app bound
on first launch. A restarted app rebinds that same port. If the port is taken,
the app binds a new one and surviving panes report `mcp offline` in the status
line until they are respawned. That condition is rare and the fallback is not
silent. A host-side proxy on a fixed port was rejected: it would put HTTP into
the host and widen its attack surface.

**Lifecycle:**

- The app starts the host if `host-endpoint.json` is missing or stale (pid
  check), otherwise it connects to the running host.
- Quit asks "Keep terminals running?". The default stays the current
  behaviour: close all panes gracefully, then the host exits. "Keep" detaches,
  and the host keeps running without a client.
- On restart the renderer calls `list`. Saved panes whose id is live
  `attach`, replay into xterm, then stream. All other panes spawn as today
  (resume included).
- **Update:** the host is installed version-stamped under
  `%LOCALAPPDATA%\<app-id>\host\<version>\`, so NSIS never replaces a
  running host binary. A new app talks to an older host if `proto` allows.
  Otherwise new panes go to a new host and old panes stay on the old one
  until they exit. A host with no client and no PTY exits after 10 minutes.
  Old version directories are pruned when no host runs from them.
- Dev builds use their own app-id, and therefore their own pipe and host,
  mirroring `tauri.dev-instance.conf.json`.

## Consequences

- PTYs, agents, dev servers and builds survive quit (on request), app crashes
  and updates. Scrollback survives up to the ring-buffer size.
- Keystrokes gain a local pipe hop. Budget: under 1 ms p99. Measure in
  phase 2 before switching the default.
- Ordering guarantees move across a process boundary:
  - keystroke FIFO per generation (one connection, in order)
  - `data` before `exit`
  - kill frees the id before a respawn
  - voice lock order `pins` → `terminals` (the app-side mirror lock is
    `terminals`; `write_checked` is resolved inside the host)
- The buzzkey contract is unchanged, because Voice stays in the app.
- A second binary to build, ship (unsigned, like the app) and license-scan. The Windows-only
  scope makes this manageable.
- New failure mode: the host dies while the app lives. The app treats this
  like every PTY exiting and offers respawn.

## Alternatives

1. **Status quo plus resume.** Already in place. Covers agent conversations
   only, not processes or scrollback.
2. **Drop kill-on-close and re-adopt processes after restart.** ConPTY master
   handles cannot be reacquired by a new process, so I/O would be lost anyway.
3. **Host as a mode of the same exe (`swarmterm --host`).** Avoids a second
   build target. It was rejected because the running host would lock
   `swarmterm.exe` and block the installer.
4. **Host as a Windows service.** Brings a different security context and
   admin install. Out of proportion for a per-user tool.

## Implementation phases (one board card each)

1. Host crate and protocol, with unit tests for framing, generation checks
   and the ring buffer.
2. App as a client behind a setting (default off), with the latency
   measurement.
3. Reattach with replay in the renderer, plus saved-workspace integration.
4. Quit dialog, versioned host install, update path, default on.

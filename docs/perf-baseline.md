# Performance baseline (perf plan, Phase 0)

Baseline for the many-panes performance work. Re-run the harness after every
phase and compare against the tables below. Keep a phase only if the numbers
improve.

## How to run

```powershell
pwsh scripts/perf/flood.ps1                          # a, b, c x 3 runs, 4 flood panes, 50 MB / 20 MB files (~12 min)
pwsh scripts/perf/flood.ps1 -Scenario a -Panes 8     # one scenario, more panes
pwsh scripts/perf/flood.ps1 -SizeMB 200 -TuiSizeMB 50 -Repeat 1   # long soak (memory growth)
pwsh scripts/perf/flood.ps1 -Trace                   # also save a Chromium perf trace per run
pwsh scripts/perf/flood.ps1 -Scenario d -Repeat 3     # agents: 15 synthetic agent panes x 150 s (~10 min)
pwsh scripts/perf/flood.ps1 -Scenario d -MockAgents   # same, as perf-mock-agent panes (detector, badges, renders)
pwsh scripts/perf/flood.ps1 -Scenario e -AgentSeconds 60   # War Room: wait_peer resolve latency
pwsh scripts/perf/flood.ps1 -Scenario f -AgentSeconds 60   # 16-20 visible panes + workspace switching
pwsh scripts/perf/flood.ps1 -Scenario g                     # tool-heavy agents: 6 panes x 75 s of spawns + file storms
pwsh scripts/perf/flood.ps1 -Scenario full -HostMode -AgentSeconds 60   # every scenario once, through the terminal host
```

`-HostMode` switches the terminal host on (Settings > Terminal) in the
throwaway perf profile before the panes are created, after building
`swarmterm-host` (`cargo build -p swarmterm-host`). The run fails if the host
is not connected, or if a dev host of this worktree already runs. Only the
host this run started is sampled and stopped (see step 5 below).

### Coverage: which change each scenario exercises

| scenario | P0 harness / probes | P1 PTY I/O threads, flusher | P2 output flow control | P3 binary IPC / host frame decoder | P4 ring size, scrollback, WebGL budget | P5 watcher storm mode | detector / badges / renders |
|---|---|---|---|---|---|---|---|
| a: sequence flood | yes | yes | yes (backpressure) | yes (batches of 8 KiB of JSON or more go raw); frame decoder with `-HostMode` | ring with `-HostMode`; scrollback and WebGL budget always | no (file watcher only) | no |
| b: TUI flood | yes | yes | yes | yes (batches of 8 KiB of JSON or more go raw); frame decoder with `-HostMode` | ring with `-HostMode`; scrollback and WebGL budget always | no (file watcher only) | no |
| c: flood + 20 idle | yes | yes | yes | yes (batches of 8 KiB of JSON or more go raw); frame decoder with `-HostMode` | ring with `-HostMode`; scrollback and WebGL budget always | no (file watcher only) | no |
| d: agents | yes | yes (echo in busy panes) | yes (tool dumps) | yes (batches of 8 KiB of JSON or more go raw); frame decoder with `-HostMode` | ring with `-HostMode`; scrollback and WebGL budget always | no (file watcher only) | with `-MockAgents` |
| e: War Room | yes | yes | yes | yes (batches of 8 KiB of JSON or more go raw); frame decoder with `-HostMode` | ring with `-HostMode`; scrollback and WebGL budget always | no (file watcher only) | yes (wait_peer path) |
| f: many visible | yes | yes | yes | yes (batches of 8 KiB of JSON or more go raw); frame decoder with `-HostMode` | ring with `-HostMode`; scrollback and WebGL budget always | no (file watcher only) | WebGL budget, DOM fallback |
| g: tool-heavy agents | yes | yes (many short child processes on the pane's console) | yes (200 KB outputs) | yes (small and large batches); frame decoder with `-HostMode` | ring with `-HostMode`; scrollback and WebGL budget always | yes (80-file storms in the watched data dir, where the files API exists) | no |

Without `-HostMode` the in-process PTY carries the output: the P2 flow gate
and P3's raw channel bodies still apply (both paths share them), but the host
frame decoder and the P4 ring buffer are not on the path. P5 (file-watcher
storm mode) is exercised only by scenario g. Add a column when a phase lands.

A single run is too noisy to compare (see Variance below). Always compare the
medians of the default 3 runs. The summary prints the median and the min-max
range per metric.

### Hard rule: only simulations run

The harness never starts an agent CLI (claude, codex, gemini, opencode, ...)
or anything that uses AI usage. Every "agent" is the local generator
`scripts/perf/agent-stream.mjs`; every War Room waiter is the spec itself
calling the app's MCP server. The one non-terminal pane type allowed is the
dev-only `perf-mock-agent` template (scenario d with `-MockAgents`, scenario
e): it is not in the template catalog, resolves only in dev builds, and its
command is exactly `node agent-stream.mjs --mock` (the copy in the perf data
dir). This is enforced three ways:

1. **Fresh empty profile.** The instance runs with its own identifier
   `com.apooooh.swarmterm.gn.perf` (a generated `--config`), and its
   `%APPDATA%` and `%LOCALAPPDATA%` folders (app data, WebView2 profile with
   the saved workspaces) are wiped before every start. The shared dev
   profile `com.apooooh.swarmterm.gn.dev` is never used, so no saved
   workspace can restore or resume an agent session.
2. **Abort on agent panes.** The spec refuses to run, before and after it
   creates its panes, if ANY workspace has a default agent or any pane has an
   agent other than `terminal` (or `perf-mock-agent` where the scenario asks
   for it, after checking in-page that it resolves to exactly the generator
   command), a session id, an account, a resume or continue session, a
   start prompt or a startup command. Panes are created as plain terminals.
3. **Process guard.** A thread polls the instance's process tree (including
   the terminal host) every 200 ms. On an agent CLI, by executable name or by
   its node package path in the command line, it writes
   `AGENT-DETECTED.txt` and kills the instance, and the run fails.

The script:
1. Generates the data files in `%TEMP%\swarmterm-perf` (once, then cached):
   - `seq-<SizeMB>.txt`: 48-byte lines `S########|<filler>`
   - `tui-<TuiSizeMB>.txt`: htop-like frames (cursor positioning, 256-colour and truecolour SGR, erase-to-EOL)
2. Starts an isolated dev instance on the fresh perf profile (see the hard rule
   above): `npx tauri dev --config <run>/tauri.perf.conf.json -- --no-default-features`
   by default (`-DevScript tauri:dev:isolated` keeps speech, where LLVM is
   available), with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`.
   It refuses to start if port 1420 is in use; if CDP port 9333 is taken it
   uses the next free one.
3. Runs `tests/perf/flood.perf.ts` once per scenario and repeat (`-Repeat`) through
   `playwright.perf.config.ts`. That config extends `playwright.config.ts` but
   attaches to the real WebView over CDP instead of the mock fixture. The spec
   creates workspaces of plain terminal panes (the first workspace is the visible
   one) and runs `cmd /d /c type <file>` in the flood panes.
4. Samples the dev instance's process tree once a second, then keeps only the
   samples inside the flood window that the driver reports. The window runs
   from the flood command to xterm's last parse of flood output.
5. Stops only what it started: `taskkill /T` on its own npm PID (after checking
   the PID's start time) and the dev `swarmterm-host.exe` processes the guard saw
   start during the run, matched by PID and start time. A running Swarmterm (`com.apooooh.swarmterm.gn`) is a
   different process tree, has its host under AppData and uses a different
   WebView2 user-data folder, so it is never touched or sampled. An existing
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` value is kept and restored.

Output goes to `test-results/perf-runs/<timestamp>/`: `summary.md`, `summary.json`,
`proc-<s>-<run>.csv` (raw samples), `webview-<s>-<run>.json` and `dev.log`.

### Scenarios

| | flood panes | idle panes | input |
|---|---|---|---|
| a | `-Panes` (4) | 1 (probed) | `-SizeMB` (50) sequence file each |
| b | `-Panes` (4) | 1 (probed) | `-TuiSizeMB` (20) escape-heavy TUI stream each |
| c | 4 | 20 (8 visible, 12 in a hidden workspace) | `-SizeMB` (50) sequence file each |
| d | `-AgentPanes` (15): 11 visible, 4 in a hidden workspace | 1 (probed, first pane) | `scripts/perf/agent-stream.mjs` for `-AgentSeconds` (150) each |
| e | `-StreamPanes` (4) streaming | `-WarPairs` (4) waiters (first probed) + 4 mock agent peers | generator for `-AgentSeconds` |
| f | `-VisiblePanes` (16) visible + 2 x 4 in other workspaces | none | generator for `-AgentSeconds` in every pane |
| g | `-ToolPanes` (6) | `-ToolIdle` (2), first probed | `scripts/perf/tool-agent.mjs` for `-ToolSeconds` (75) each |

Scenarios d, e, f and g are not part of `all`. Run them with `-Scenario <s>`, or
everything once with `-Scenario full` (d then uses mock agents).

### Scenario g (tool-heavy agents)

Each tool pane runs `node tool-agent.mjs <seconds> <n>` in its plain shell. On
a fixed, seeded 12-step cycle it spawns short cmd.exe one-liners and small
`for /l` loops (every few cycles `pwsh -NoProfile` or a `type` of a ~200 KB
file instead), all sharing the pane's console, writes and reads 20 small
files, creates and deletes 80 files in a fresh `storm-<round>` folder (160+
raw events, past the watcher's `RESCAN_BURST` of 64, so every storm enters
storm mode), appends 50 lines to a log, and pauses 0.3-1.2 s. Files live in
`perf-tool-ws\<n>` under the data dir and are removed at the end, on Ctrl+C
and by the spec's teardown. Each generator writes `perf-tool-<n>.json`: spawn
counts and round trips (spawn to exit) per kind, failed spawns, file ops and
each storm's folder, start and end. The summary shows per kind the total
count, the median over panes of each pane's p50 / p95, and the overall max.
Before the run the spec opens a file context on the first tool pane and
watches its root (the data dir) like the file explorer does, recording every
`files:changed` event until the run ends. Storm latency runs from a storm's
start to the first event naming its folder, or the first rescan after its
end (storm mode skips later batches and sends one rescan after
`RESCAN_QUIET`, 500 ms without raw events, which the other panes' file
traffic can push out); over 5 s counts as missed. Builds without that files
API report the file metrics as `unsupported`. Echo is probed in the first
idle pane. A run takes `-ToolSeconds` plus setup and up to 15 s waiting for
the generators' summaries.

### Scenario d with `-MockAgents`

The agent panes are `perf-mock-agent` panes: the template line starts
`agent-stream.mjs --mock`, which waits for `perf-mock.json` (the spec's start
signal), adds idle phases and sets the OSC title to `perf-mock working` /
`perf-mock idle`. A dev-only manifest maps that to agent states, so the
detector, the tab dots and the attention badge run. A dev-only counter
(`src/lib/perf-render-count.ts`, active only while the harness sets
`window.__perfRenderCounts`) reports WorkspaceTabs and AttentionBadge renders
in summary.md.

### Scenario e (War Room)

The waiters and the mock peers join a fresh War Room through
`war_room_join`, the command the app's drag-and-drop uses. Each waiter loops
`war_room.wait_peer` (`afterChange: true`) over the app's MCP server with its
own pane token, as an agent's MCP client would. The mock logs every idle flip
(`perf-mock-<pane>.log`, epoch ms), and the resolve latency is the call's
return minus the newest idle flip inside the call. It covers generator ->
ConPTY -> xterm -> detector -> mirror IPC -> peer state -> MCP answer.
Calls still waiting at the end return `timeout`; they are not failures.

### Scenario f (many visible)

16-20 panes in the visible workspace (12 from the wizard, the rest split) and
two 4-pane workspaces, every pane streaming the generator. The spec switches
the active workspace every `-SwitchSeconds` (3) and samples
`perfRendererStats()` from the terminal registry: live WebGL contexts and
visible panes on the DOM fallback.

### Scenario d (agents)

`agent-stream.mjs` imitates a TUI coding agent with a seeded random model.
It uses no network.

- A spinner and status line redrawn at ~15 Hz (save/restore cursor, SGR,
  erase line) below a scroll region.
- Phases: think (spinner only, 1-5 s), stream (markdown/code lines at about
  40-90 tokens/s, 4-14 s), and tool (a 100-400 KB dump in one write, ~25 % of
  phase changes).
- OSC 0 title and OSC 9;4 progress about once a second.
- An input box that echoes each keystroke at once as `IN#<n>:<char>`.

Extra metrics:

- **Echo in a busy pane.** Probes alternate in blocks of 16 between the idle
  pane and the first agent pane. A busy probe counts when `IN#<n>:<char>`
  appears on the parsed screen. ConPTY sends only changed cells, so the
  screen is matched, not the chunk. The busy timeout is 10 s, so stalls behind
  a tool dump are measured instead of being cut off at 3 s.
- **Delivery lag.** Each line starts with `@T<epoch ms>|` (streamed text) or
  `@D<epoch ms>|` (tool dump), stamped when the generator writes it. The probe
  records `Date.now() - ts` at hand-over to xterm (`Terminal.write`) and at
  xterm's parse callback. It reports p50/p95/max over all panes, the worst
  pane's p95, and each pane's figures in the JSON. Tokens older than the last
  one seen in that pane are ConPTY repaints and are not counted.
- **Hand-over vs parse.** Hand-over lag covers generator, ConPTY, reader,
  flusher and IPC. The gap from hand-over to parse is xterm's own write queue.
- CPU and memory as in a-c, over the fixed `-AgentSeconds` window.

Smoke run (15 panes x 30 s, 1 run, P1 build, other builds running): idle echo
p95 47 ms; busy echo p95 33 ms with 4 of 40 probes over 3 s; streamed and
dump lag pooled at parse p50 92 / p95 249 / max 284 ms, of which hand-over
was p50 84 / p95 202 ms; 2 frames over 50 ms; WebView 688 -> 1016 MB. This
run is not a measurement. The 3-run comparison before and after P1 is pending.
### Metrics and how they are measured

- **CPU / private memory**:
  - Processes: `swarmterm.exe` (app) and all `msedgewebview2.exe` (WebView) in
    the dev tree, plus `swarmterm-host.exe` (host). The host is launched with
    CREATE_BREAKAWAY_FROM_JOB, so it is found by its path,
    `<worktree>\src-tauri\target\debug\swarmterm-host.exe`, and only if it
    started during the run.
  - Taken from `Get-Process` every ~1 s and trimmed to the flood window. A
    process's first reading has no CPU delta and is left out.
  - CPU is a percentage of the **whole machine** (all logical cores), so 3 % on
    32 threads is about one core.
- **Long tasks / frame time**:
  - A `PerformanceObserver('longtask')` and a `requestAnimationFrame` loop in the
    main WebView, recorded only during the flood.
  - The run refuses to start when the window is not visible, and the time spent
    hidden is reported (`hidden ms`), because rAF is throttled in background.
    Do not minimise or cover the dev window during a run.
  - `-Trace` also writes a Chromium trace (`trace-<s>.json`, open it in
    DevTools > Performance).
- **Keystroke echo latency**:
  - Playwright presses one letter (`z x j q`, none of which occur in the
    prompt) in the focused idle pane and waits in-page for its echo, up to 3 s,
    then counts it as unanswered. Only one probe is ever outstanding. Probes are
    at least 250 ms apart, and Escape clears the line every 16 probes.
  - The latency runs from the keydown event's `timeStamp`, so main-thread
    queueing counts, to the parse callback of the first write to that terminal
    that contains the letter (escape sequences stripped).
  - Path covered: renderer -> IPC -> PTY -> shell echo -> ConPTY -> reader ->
    IPC -> xterm parse.
- **Line integrity** (instead of a byte checksum, see Limitations):
  - `Terminal.prototype.write` of the app's own xterm module is wrapped, with one
    `TextDecoder` per terminal.
  - Per terminal it checks the `S########|` tokens in the *parsed* stream for
    gaps, duplicates, and an FNV hash of the sequence against `0..N-1`
    (`hashOk`).
  - It also counts UTF-16 characters handed to xterm whose write callback never
    fired (`unparsed`). xterm drops writes past its 50 MB pending limit
    without calling back, so a non-zero value at the end means a backlog or
    dropped data.
- **End of a run**: every sequence is complete, or there has been no output
  for 60 s and either nothing is still unparsed or nothing has parsed for 60 s,
  or the timeout is reached. The probed pane's echo does not count as output.

## Baseline: 2026-10-19, `dev` at b554128

- Machine: i9-13900K (32 threads), 32 GB, Windows 11. Other agents' builds ran on
  the machine at the same time, so the load is uncontrolled.
- Build: dev (unoptimised Rust, Vite dev server).
- Backend: in-process PTY. The terminal host is off by default, so it has no row.
- Run: `20261019-134448` with the defaults (4 flood panes, 50 MB / 20 MB, 3 runs
  per scenario, all in one dev instance one after another).
- Values are **median (min-max) over the 3 runs**.
- WebView memory carries over between runs and scenarios in the one instance,
  so its row mixes carry-over with per-run growth (see Variance).
- Scenario b always ends on the 60 s quiet wait (no sequence to complete), which
  adds about a minute of wall time per run but is outside the measured window.
  Scenario a or c also waits 60 s if its last line never arrives.

| | a: 4 x 50 MB | b: 4 x 20 MB TUI | c: 4 x 50 MB + 20 idle |
|---|---|---|---|
| echo p50 | 29.1 (29.1-29.6) ms | 30.0 (29.8-30.0) ms | 29.9 (29.8-30.0) ms |
| **echo p95** | **32.2 (32.0-61.7) ms** | **31.3 (31.0-31.4) ms** | **32.9 (32.9-34.5) ms** |
| echo max | 65 (39-166) ms | 55 (48-83) ms | 49 (43-121) ms |
| echo samples / unanswered | 161-253 / 0 | 273-277 / 0 | 165-181 / 0 |
| frames > 50 ms | 0 (0-0) | 0 (0-3) | 1 (0-1) |
| long tasks > 50 ms | 0 (0-0) | 0 (0-0) | 0 (0-1) |
| app CPU avg | 5.1 (3.6-5.3) % | 0.3 (0.2-0.4) % | 5.1 (5.1-5.3) % |
| WebView CPU avg | 3.1 (2.4-3.5) % | 3.0 (2.7-3.1) % | 4.4 (4.2-4.7) % |
| WebView private MB max (cumulative in instance) | 1759 (1104-2282) | 3709 (3551-3732) | 4825 (3422-6222) |
| lines lost (all panes, all runs) | 0, all hashOk | n/a | 0, all hashOk (7-8 duplicate tokens per pane) |
| longest output gap | 26-35 ms | 32-100 ms | 38-93 ms |
| flood duration | 42 (41-67) s | 12 (11-13) s | 46 (43-47) s |

### Variance

- **The 50 MB default is stable.** Across 3 runs, echo p95 stays within
  31-35 ms, except one outlier (a, run 1: 61.7 ms, with a 67 s flood instead of
  42 s). That outlier is why the harness reports the median.
- **Single runs at 200 MB were not stable.** Earlier harness versions gave echo
  p95 of 291, 32 and 308 ms for scenario a on the same build. One of those runs
  also had an output stall of 15+ s, which the old 15 s quiet rule mistook for
  the end of the flood. Flood duration ranged from 168 to 389 s. The cause is
  not established; uncontrolled machine load is the main suspect.
- **WebView memory is the noisiest metric.** It accumulates across the
  scenarios that share one instance (a -> b -> c), so its spread is mostly run
  order. For memory, use `-Scenario <s> -Repeat 1` in a fresh instance, or the
  long soak.
- Rule of thumb for comparing phases: treat a change as real only when the new
  median lies outside the old min-max range.

### Reading the baseline

- **At 4 flood panes, echo meets the target.** p95 is about 31-33 ms against
  the < 50 ms goal. Only the max (up to 166 ms) shows stalls.
  - Note: the first version of this harness reported p95 of about 1 s. That came
    from a broken echo matcher (a FIFO queue over letters that also occur in the
    prompt), not from the app.
- **The WebView main thread is mostly idle-capable.** There are 0-1 long tasks
  and 0-3 frames over 50 ms per run.
  - The longer 200 MB runs show the stalls more clearly. Scenario c had up to
    9 long tasks, frames up to 825 ms and an echo max of 0.3-1.8 s.
  - Use `-SizeMB 200 -Repeat 1` as a soak check alongside the default.
- **WebView memory grows with output and is not released.** In one instance it
  climbs from about 0.7 GB to 3.4-6.2 GB over the 9 runs, and reaches 7.8 GB in
  a 200 MB soak.
  - Scrollback is capped at 5000 lines, so the visible buffer is not the cause.
  - What holds the memory is not shown by this harness. Retained IPC or write
    queues are a hypothesis.
- **No loss at this load.** Every sequence line arrived in order, with nothing
  unparsed, in all 24 pane-runs. The 7-8 duplicate tokens per pane in c are
  probably ConPTY repainting rows of the narrow or hidden panes. That is a
  hypothesis, and duplicates do not count as loss.
- **The Rust app's CPU and memory are small.** Enable the terminal host
  (Settings > Terminal in the dev instance) to fill in the host row. That run is
  not in this baseline.

## Phase 2 note: flow control

Since perf phase 2 output is flow-controlled (`host/src/flow.rs`, used by the
host and the in-process PTY alike): while more than 512 KiB per pane is unacked between
Rust and xterm, reading pauses until xterm's parse callbacks ack it back below
128 KiB (or no ack arrives for 2 s), and the rest stays in the child (ConPTY
backpressure). Scenario a/b throughput is therefore bounded by xterm's parse
rate, and WebView memory should stay flat during floods. Compare memory, not
just MB/s, against the baseline above.

## Phase 3 note: channel bodies

A `Data` batch whose JSON string is under 8 KiB (`DIRECT_JSON_LIMIT` in
`pty.rs`, Tauri's direct-eval limit) still goes as JSON, as before phase 3;
only larger batches go as raw bytes, which skip JSON escaping and parsing.
Small echo-sized batches therefore cost the same as before.

## Phase 4 note: memory and GPU

The host keeps 512 KiB of replay history per pane (was 1 MiB). Scrollback is a
setting (Settings > Terminal, default 5,000 lines, 500-50,000), and at most 12
visible panes hold a WebGL context; the rest use the DOM renderer (scenario f).
Superseded by the renderer policy (`src/lib/renderer-policy.ts`): WebGL at
pane open for up to 16 panes, kept while hidden (up to 16 hidden contexts,
traded for instant workspace switches), oldest evicted first.

## Phase 5 note: file watcher

The file watcher switches to storm mode on a burst of 64 raw events and sends
one rescan after 500 ms of quiet. None of the flood scenarios touches it.

## Limitations (stated honestly)

- **No byte checksum.** ConPTY does not pass bytes through. It re-renders the
  screen and emits its own VT stream, so a byte checksum of xterm input against
  the source file can never match, even with zero loss. The harness checks line
  integrity with the sequence tokens instead. Lines are 46 visible characters so
  that no pane is narrow enough to wrap a token. Scenario b has no loss metric:
  ConPTY may legitimately coalesce TUI frames.
- **Echo latency stops at parse.** It does not include the paint after the parse
  (at most about one frame), and it uses synthetic CDP key events, which skip OS
  input queueing. For
  display-to-photon latency, use a manual check: type in the idle pane during
  `-Scenario c` and record the screen with a 240 fps camera.
- **CPU sampling** uses `Get-Process` deltas at ~1 s. The process tree is
  refreshed every 10 samples, so a process that starts mid-window is picked up
  late. Short spikes are averaged out.
- **Dev build.** This baseline uses the unoptimised debug Rust and the Vite dev
  server. The relative change between phases is what matters. For absolute
  numbers, a release-build run needs a manual procedure. Build with
  `npm run tauri build -- --no-bundle --config src-tauri/tauri.dev-instance.conf.json -- --no-default-features`.
  The dev identifier is needed; otherwise the single-instance lock hands the
  launch to the running app. Then start `src-tauri/target/release/swarmterm.exe`
  with the env var above and run the spec by hand with the `PERF_*` variables
  (see the header of `tests/perf/flood.perf.ts`). A release build has no Vite
  server, so the spec's `/src/...` imports do not resolve there. This path is
  not automated and needs a probe exposed by the app first.
- **Coordinated omission.** Only one probe is outstanding at a time, so a 1 s
  stall yields one sample instead of about four. p95 and max therefore
  under-weight stalls. Read the max and the long-task and frame columns together
  with the echo percentiles.
- **Visibility.** It is checked at the start, and minimising later is counted
  in `hidden ms`. Occlusion by another window is not detected, so keep the dev
  window uncovered.
- **Host discovery** uses `%CARGO_TARGET_DIR%` or `src-tauri\target`, then
  `debug\swarmterm-host.exe`. A dev host left over from an earlier run is
  treated as foreign: the script warns, does not sample or stop it, and the
  host row stays empty.
- **Probe overhead.** The probe adds work to every write: one regex scan per
  chunk (scenario d: three). Compare runs only with runs from the same harness version.
- **The host path is not in this baseline.** It ran with the host off; use
  `-HostMode` for host numbers.
- **Delivery-lag clock.** The generator and the WebView both use the system
  clock (`Date.now()`), with 1 ms resolution. A tool dump's tokens are stamped
  while its string is built, just before the single write.
- **Shared startup side effects.** The perf instance does what any dev
  instance does at boot (for example the Codex config rewrite in
  `hook/codex.rs` and the MCP server). None of it starts an agent.

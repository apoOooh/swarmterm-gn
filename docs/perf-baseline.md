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
```

A single run is too noisy to compare (see Variance below). Always compare the
medians of the default 3 runs. The summary prints the median and the min-max
range per metric.

The script:

1. Generates the data files in `%TEMP%\swarmterm-perf` (once, then cached):
   - `seq-<SizeMB>.txt`: 48-byte lines `S########|<filler>`
   - `tui-<TuiSizeMB>.txt`: htop-like frames (cursor positioning, 256-colour and truecolour SGR, erase-to-EOL)
2. Starts the isolated dev instance (`npm run tauri:dev:no-speech` by default,
   `-DevScript tauri:dev:isolated` where LLVM is available) with
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`. It refuses to
   start if port 1420 or 9333 is already in use.
3. Runs `tests/perf/flood.perf.ts` once per scenario and repeat (`-Repeat`) through
   `playwright.perf.config.ts`. That config extends `playwright.config.ts` but
   attaches to the real WebView over CDP instead of the mock fixture. The spec
   creates workspaces of plain terminal panes (the first workspace is the visible
   one) and runs `cmd /d /c type <file>` in the flood panes.
4. Samples the dev instance's process tree once a second, then keeps only the
   samples inside the flood window that the driver reports. The window runs
   from the flood command to xterm's last parse of flood output.
5. Stops only what it started: `taskkill /T` on its own npm PID (after checking
   the PID's start time) and any dev `swarmterm-host.exe` of this worktree that
   was not running before. A running Swarmterm (`com.apooooh.swarmterm.gn`) is a
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
  chunk. Compare runs only with runs from the same harness version.
- **The host path is untested.** Host discovery and stopping by path are
  implemented, but this baseline ran with the host off.

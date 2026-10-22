# Perf profiling

Tooling to measure where time goes in a flood scenario instead of guessing.
It sits beside the A/B harness (`scripts/perf/flood.ps1`, `docs/perf-baseline.md`)
but never feeds it: every probe perturbs timing, so **profile runs are never
mixed into A/B tables**. They land in `test-results/perf-profile/<stamp>/`
(gitignored), not `perf-runs/`, with a `PROFILE-RUN.txt` marker.

## Quick start

```powershell
# One scenario, V8 CPU profile + Rust counters + 1 Hz process CPU:
pwsh scripts/perf/flood.ps1 -Scenario a -Repeat 1 -Profile
# Chrome trace window (15 s, PERF_PROFILE_TRACE_S=5..30) or heap sampling:
pwsh scripts/perf/flood.ps1 -Scenario d -Repeat 1 -Profile -ProfileMode trace
pwsh scripts/perf/flood.ps1 -Scenario f -Repeat 1 -Profile -ProfileMode mem
# Plus ETW through the admin broker (spawn = Kernel-Process starts/stops,
# cpu = WPR CPU, wait = WPR CPU + Latency):
pwsh scripts/perf/flood.ps1 -Scenario c -Repeat 1 -Profile -Etw spawn
# Re-print a summary:
node scripts/perf/profile-summary.mjs test-results/perf-profile/<stamp>/a-1 20
```

Each scenario run gets `<stamp>/<scenario>-<rep>/` with the raw files and
`summary.txt` (the same top-N tables the script prints).

The first summary line is always completion time (flood seconds, or run
seconds for fixed-duration scenarios), total wall time, the instance's total
CPU seconds (1 Hz sampler) and **CPU per unit of work** (`work.json`: MB
delivered for a/b/c, pane-seconds for d/e/f) plus throughput. Judge a change
on both: more CPU that finishes sooner (lower CPU/unit, higher throughput) is
a win.

## What each part answers

| Output | Source | Answers |
|---|---|---|
| `renderer.cpuprofile` | CDP `Profiler`, 1 ms sampling (`cpu`) | Which JS functions burn renderer main-thread time (self time). Opens in DevTools / speedscope. |
| `renderer.json` → `loaf` | `long-animation-frame` observer | Which scripts (function + file, forced layout) cause frames > 50 ms. |
| `renderer.json` → `metrics` | `Performance.getMetrics` start/end | Script vs layout vs style time, JS heap. |
| `renderer.json` → `processCpu` | `SystemInfo.getProcessInfo` | CPU per WebView2 process type: renderer vs GPU vs browser. |
| `trace.json` (`trace`) | Chrome tracing, one bounded window (first 5-30 s of the run only) | Frame pipeline, GPU, IPC; open in `chrome://tracing` / Perfetto. |
| `renderer.heapprofile` (`mem`) | `HeapProfiler` sampling | Allocation sites. |
| `procs.csv` | `profile-procs.ps1`, 1 Hz | CPU and private memory per pid: `msedgewebview2` by `--type`, `conhost`/`OpenConsole`, app, host. Only the instance's own tree. |
| `rust.json` | `profiling` feature (`src-tauri/src/prof.rs`) | Lock wait/hold per call site, flow-gate park time, read-queue backpressure, command and IPC send spans, main-thread dispatch delay + stalls > 16 ms, tokio workers/alive tasks/global queue. |
| `etw-spawn.csv` (`-Etw spawn`) | logman Kernel-Process via broker, read with `Get-WinEvent` | Process start/stop timeline (pane spawn cost, conhost churn). |
| `etw-cpu-summary.txt` (`-Etw cpu|wait`) | WPR via broker, `tracerpt -summary` | Event counts only. Per-stack CPU/wait analysis needs WPA/wpaexporter (Windows Performance Toolkit), **not installed** on this machine. |

ETL files are deleted after summarizing.

## Rust instrumentation (`profiling` feature)

- `cargo check --profile profiling --features profiling --no-default-features`
- `[profile.profiling]` inherits `release` with `debug = "line-tables-only"`,
  `strip = false`; output in `src-tauri/target/profiling/`, apart from
  `debug/` and `release/`, so A/B binaries are never overwritten.
- Without the feature every helper in `prof.rs` compiles to the plain
  operation (`prof::lock` = `lock().unwrap()`, spans are zero-sized), so normal
  builds are unchanged. Thread names (`pty-reader-<id>`, `pty-flusher-<id>`,
  `pty-writer`, `pty-waiter-<id>`, `pty-close`, `pty-killer`, `host-boot`,
  `host-sweep`) are set in every build; the tokio runtime is replaced by a
  named one (`tokio-rt`) only in profiling builds.
- Histograms: count, total, max, log2-µs buckets (p50/p99 are bucket upper
  bounds). Names: `lock.<lock>.<site>[.wait]`, `lock.spawn.wait`, `flow.park`,
  `chan.read_queue.send_block` (time the reader blocked on the full
  `sync_channel` = flusher/flow gate behind; true send→recv latency and queue
  length are not measured), `cmd.*`, `ipc.channel_send`, `main.dispatch_delay`.
- Dumps: on exit, and when `dump.request` appears in `SWARMTERM_PROFILE_DIR`
  (default `%TEMP%\swarmterm-profile`); `reset.request` clears the counters.
  The watchdog thread polls both every 50 ms. flood.ps1 resets before and
  dumps after each scenario. Stall `at_ms` counts from `prof::start` in app
  setup, not process start, so align it with ETW times only roughly.
- Not instrumented: the host process (`src-tauri/host`, its `Output` locks).

## samply (optional, not installed)

`cargo install samply --locked`. Attaching to a running pid on Windows needs
elevation, which the admin broker does not offer yet; until it does, profile
the native side with `-Etw cpu` (WPR) or run the profiling binary directly
under `samply record --save-only -o prof.json.gz target\profiling\swarmterm.exe`
from an elevated shell. The `profiling` cargo profile keeps the line tables
samply needs.

## Admin

Nothing in this flow elevates. ETW goes through the admin broker in the
project folder (`admin-broker\`, started once per session by the user,
whitelisted logman/wpr actions only). If `admin-broker\ready` is missing,
`-Etw` is skipped with a warning. Override the location with
`SWARMTERM_ADMIN_BROKER`.

## Perturbation

- CPU sampling at 1 ms costs a few % renderer CPU; tracing much more. Compare
  profile runs only with profile runs of the same mode.
- Rust counters take one global registry mutex per sample; under a heavy flood
  that is visible as its own contention. Use them for ranking, not absolutes.
- The profiling build is `tauri dev` (Vite dev server) with release codegen,
  so renderer code is unbundled dev code, like the A/B harness.
- The 1 Hz sampler runs a CIM query every 5 s plus `Get-Process` per second.

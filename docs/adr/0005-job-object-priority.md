# ADR 0005: Process priority enforced by Job Objects

- Status: accepted
- Date: 2026-10-29

## Context

Settings → Terminal "Lower build priority" (`src-tauri/src/child_priority.rs`
before this change) was meant to keep agent-launched work below Normal, but
heavy loads still made Windows unresponsive. The design was an app-side
poller that called `SetPriorityClass(BELOW_NORMAL)` every 500 ms on
processes found by walking Toolhelp parent PIDs below each pane shell.
It had five holes:

1. **Polling race.** Anything that started and saturated the cores inside
   the 500 ms window ran at Normal, and so did its children.
2. **Launcher whitelist.** Outside a recognised native agent, `node`,
   `python`, `pwsh`, `bash`, `cmd`, `uv`, … stayed Normal. An npm-shimmed
   agent (`node cli.js`) was never recognised, so `python heavy.py` under it
   stayed Normal with everything it started.
3. **Orphans.** When an intermediate process exited (`start`, daemons,
   MSBuild node reuse, sccache), its children fell out of the parent walk.
4. **Raise-back.** A process could call `SetPriorityClass(NORMAL)` on itself;
   the memo marked it handled and it was never lowered again.
5. **One level.** BelowNormal was hard-coded; the setting was on/off.

## Decision

Enforce priority in the kernel through the per-pane kill-on-close Job
Object every pane shell already sits in (`src-tauri/host/src/job.rs`, used
by both the terminal host and, since this change, the in-process backend).

- `JOB_OBJECT_LIMIT_PRIORITY_CLASS` on the pane job (strict mode) forces one
  class on every process in it. The job is born with the limit before the
  shell runs anything, so there is no race; children are born inside the
  job; the pane job never sets `BREAKAWAY_OK`. Processes in the job cannot
  change their class.
- A nested **build job** (no kill flag; it dies with the pane job) gets the
  build class. It is nested below the pane job on purpose when it is
  created (a suspended `cmd.exe` joins the pane job, then the empty build
  job, and is terminated), because an empty job joins the hierarchy of the
  first process assigned to it (see "libuv" below). A watcher (`host/src/priority.rs`, 500 ms) runs the pure
  rule `plan` over the pane job's own PID list
  (`JobObjectBasicProcessIdList`, which includes nested members) joined with
  Toolhelp rows for parent and exe, and moves subtree roots below an agent
  into it with `AssignProcessToJobObject`. Later descendants are born there.
  A member whose parent is not in the job hangs below the shell, so orphans
  follow the same rule.
- Agents are recognised natively (`AGENT_EXES`, mirrored from
  `agents::AGENTS`) or, for `node`/`bun`, by command line
  (`NtQueryInformationProcess(ProcessCommandLineInformation)`, once per
  process via the memo) against npm package markers (`AGENT_MARKERS`,
  mirrored from `agent_process::script_markers`; an app test keeps both in
  step).
- Optional hard CPU cap: `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION` with
  `ENABLE | HARD_CAP` on the pane job; the nested job inherits it.
- Settings (Settings → Terminal → Process priority), pushed by the renderer
  via `child_priority_set` and forwarded to the host as `set_priority`
  (capability `priority`; also sent on every new host connection before any
  create):
  - `mode`: `strict` (default), `agent-normal`, `off`;
  - `paneLevel` (strict only): BelowNormal (default) or Idle;
  - `buildLevel`: Idle (default) or BelowNormal;
  - `cpuCap`: 1–99 % or none (default);
  - `exempt`: terminal ids of panes whose workspace opted out.
  Normal and higher are not representable. Live changes apply to running
  panes; lifting a limit raises members still below Normal back to Normal.
- The app-side poller is removed. Renderer storage moves from the boolean
  `swarmterm.lowerBuildPriority` to the JSON `swarmterm.processPriority`
  (`'false'` migrates to `off`, anything else to the defaults).

### User decisions (2026-10-29)

- Ship both modes, `strict` and `agent-normal`; **strict is the default**.
- Offer the CPU cap as an **optional** setting, off by default.

### libuv's own job (verified in the libuv source, `src/win/process.c`)

`uv__init_global_job_handle` creates ONE job per libuv process on its first
`uv_spawn`, with `KILL_ON_JOB_CLOSE | BREAKAWAY_OK | SILENT_BREAKAWAY_OK |
DIE_ON_UNHANDLED_EXCEPTION`, assigns the libuv process itself to it, and
assigns every child it spawns without `UV_PROCESS_DETACHED`. In a pane that
job is nested in the pane job. So for a Node agent (`node cli.js`):

- node and its direct children sit in the libuv job; their children break
  away from it silently and stay in the pane job only (it allows no
  breakaway);
- had the agent's direct child created the build job, the build job would
  nest under the libuv job: its members would die with the agent, and every
  later process outside the libuv job would be refused (the old race back);
- with the build job nested under the pane job, an agent's direct child
  cannot join it (`Assign::Refused`, logged once, memoised): it keeps the
  pane class (strict: BelowNormal; agent-normal: Normal). Its children, and
  everything below them, go into the build job as usual.

Bun on Windows was not checked; it is handled the same way either way.

## Verified behaviour (Windows 11, 2026-10-29)

Microsoft docs: the effective class of a nested job is the lowest in the
chain; CPU rates of a nested job are relative to the parent's. Tested in
`src-tauri/host/tests/priority.rs` with synthetic processes only:

- a child started after capture has the job's class; running members are
  moved at once; `SetPriorityClass(NORMAL)` from outside does not stick;
- PowerShell setting its own class to Normal stays BelowNormal;
- an orphan (`start /b ping`, parent exited) stays in the job and capped;
- a process already in the pane job can be assigned to a new nested job,
  which then lowers it further; a nested level above the pane's is clamped;
- the CPU cap is accepted on a pane job that then gets a nested job;
- `set_limits` tightens and lifts live (lifting raises back to Normal);
- agent-normal: a fake `claude.exe` keeps its class, its `ping` goes Idle;
- Node (`node <tmp>/@anthropic-ai/claude-code/cli.js` spawning `cmd /c ping`):
  node's `cmd` is refused and stays BelowNormal, `ping` goes Idle and
  survives when node is terminated (the build job is not in the libuv job);
- a child, and a grandchild, the shell started before capture are swept
  into the pane job;
- an early `node` (libuv job of its own) and its direct child are strays at
  BelowNormal, forced back after an outside raise, Normal again when the
  limit is lifted; node's grandchild is captured.

No privilege beyond the default token was needed to set below-Normal
class limits.

## Consequences

- Holes 1, 3, 4 and 5 are closed by the kernel; hole 2 is closed for
  recognised npm agents, and fully in strict mode (the whole pane is capped
  whatever runs in it).
- Strict mode also lowers the agent and interactive programs in a pane.
  They yield only to Normal work (the UI, the desktop), which is the point.
- In `agent-normal` mode an unrecognised agent under a launcher keeps
  Normal, as before.
- Residual escapes (no job-based scheme can catch them; documented in the
  user guide): processes created via WMI `Win32_Process.Create`, Task
  Scheduler and services, out-of-process COM servers, and ShellExecute
  through Explorer. A later option is a per-user low-priority sweep.
- Spawn-to-capture window: the shell runs briefly before it is captured.
  Closing it at the source (shell created suspended, assigned, then
  resumed; or `PROC_THREAD_ATTRIBUTE_JOB_LIST`) is not possible with
  portable-pty 0.8: `ConPtySystem` calls `CreateProcessW` itself with fixed
  flags (`EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT`) and an
  attribute list holding only the pseudo console, with no hook for either;
  doing it would mean our own ConPTY spawn for both backends. Instead, right
  after capture the shell's Toolhelp descendants are swept into the job: a
  row counts only if it was created after its own parent (a reused PID
  never pulls in a stranger), and a round that assigned something is
  repeated (up to 8) so a grandchild started meanwhile is caught.
  A descendant that already has a job of its own (a profile hook's `node`
  with its libuv job) cannot join: it is logged as a WARNING, kept as a
  stray, set to the pane class (or the build class in agent-normal) with
  `SetPriorityClass`, and forced back to it on every watcher pass; its new
  descendants are swept again each pass. With no class to force (priority
  off, exempt workspace) the watcher leaves strays alone (no forcing, no
  sweep, no snapshot); they are raised back to Normal once, when a limit is
  lifted. Remaining window for such a
  stray: it is not in the pane job (no kill on close, no CPU cap), it can
  raise itself for up to one watcher period, and children it starts with
  breakaway sit outside until the next pass. A process that both started
  and exited inside the spawn-to-capture window, or whose parent exited
  before the sweep (no parent link left), ran unlimited.
- Creating the build job briefly adds a suspended, never-run `cmd.exe` to
  the pane job (`nest_build`); a process-count limit on the pane job would
  have to allow for it. If that nesting fails it is not retried for the
  pane, and the pane's processes keep the pane class.
- In agent-normal mode the direct children of a Node (libuv) agent cannot
  join the build job and stay Normal; work they start does join it, after
  up to one watcher period at Normal (in strict mode everything is at the
  pane class from birth anyway).
- A terminal host started by an older app version does not know
  `set_priority` and does not announce the `priority` capability. Its own
  panes stay unlimited until that host exits; new panes are spawned
  in-process (enforced) while it runs, and Settings → Terminal → Process
  priority says why.
- A failed capture (no job) is logged with the pid and Win32 error; that
  pane runs unlimited and without the tree kill.
- An older app talking to a newer host never sends `set_priority`, so that
  host keeps the strict defaults and the old app cannot turn them off.
- Startup window: the app and a fresh host start at the strict defaults
  until the renderer's first push. A user whose stored mode is `off` sees
  panes spawned or adopted in that moment limited, then raised back to
  Normal by the push. Lifting a limit raises every member still below
  Normal, including a process that lowered itself on purpose: the job
  cannot tell the two apart.
- Relaxing a level (Idle to BelowNormal) applies to running members, too:
  the class limit sets the class, it does not only cap it (tested).
- The watcher holds strong job handles during one pass (Toolhelp snapshot
  plus command-line reads), so a pane dropped meanwhile is killed on close
  up to that much later; explicit `terminate()` paths are unaffected.
- The watcher (`priority::os`), `job.rs` and the host's server are
  Windows-only, like the fork; the pure rule and settings are not.
- Command routines (`routine_cmd.rs`) keep a job without priority limits:
  their lines come only from the user's own dialog.

## Alternatives

- **Keep the poller, poll faster.** Still racy, still undone by the process.
- **Lower the shell at spawn only (inherited class).** Children inherit,
  but any process can raise itself again.
- **`CREATE_SUSPENDED` + set class before resume.** Covers the shell only.
- **Raise Swarmterm instead of lowering builds.** Needs elevation for
  High, and still loses to the rest of the desktop stalling.

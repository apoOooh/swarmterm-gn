<#
.SYNOPSIS
  Perf flood benchmark against an isolated Swarmterm dev instance (perf plan, Phase 0).

.DESCRIPTION
  Starts the isolated dev instance (identifier com.apooooh.swarmterm.gn.dev) with
  WebView2 remote debugging, generates the data files, then runs
  tests/perf/flood.perf.ts (Playwright over CDP) for each scenario while this
  script samples CPU and private memory of the instance's process tree:
    a  N panes each typing a -SizeMB (default 50 MB) sequence-numbered file (cmd /c type)
    b  N panes of escape-heavy TUI output (SGR colours + cursor movement frames)
    c  20 idle panes plus 4 streaming the scenario-a file
    d  -AgentPanes (15) panes each running scripts/perf/agent-stream.mjs, a
       local generator of agent-like output (spinner/status redraws, streamed
       markdown, tool-output dumps, OSC title/progress) for -AgentSeconds,
       plus 1 idle pane; echo is probed in the idle and in a busy pane, and
       per-pane delivery lag is read from timestamps in the stream.
       -MockAgents: the agent panes use the dev-only perf-mock-agent template
       (same generator in --mock mode), so the agent detector, tab badges and
       state flips run; WorkspaceTabs/AttentionBadge renders are counted
    e  War Room: -WarPairs mock agent peers plus as many plain waiter panes
       in one room; each waiter calls war_room.wait_peer over MCP (as an
       agent's MCP client would, with the pane's own token) while
       -StreamPanes other panes stream; reports the resolve latency
    f  -VisiblePanes (16-20) streaming panes visible in one workspace plus two
       4-pane workspaces, switching every -SwitchSeconds; reports live WebGL
       contexts and visible DOM-fallback panes
    g  -ToolPanes (6) panes each running scripts/perf/tool-agent.mjs for
       -ToolSeconds (75): tool-heavy agent work (many short cmd/pwsh child
       processes, bursty small output, file create/read/write/delete storms
       of 80 files in perf-tool-ws\<n> under the data dir, appends, a ~200 KB
       type now and then) plus -ToolIdle (2) idle panes, the first probed;
       reports spawn round trips and, where the files API exists, the
       watcher's file events and storm-to-event latency
    full  a, b, c, d (mock agents), e, f and g, once each
  -HostMode switches the terminal host on in the throwaway perf profile
  (builds swarmterm-host first), so output runs through the host path.
  HARD RULE: no agent CLI or AI provider is ever started. Every pane is a
  plain shell. The instance runs on its own identifier
  (com.apooooh.swarmterm.gn.perf) whose app-data and WebView2 profile are
  deleted before every start, so no saved workspace or session can be
  restored; the spec refuses to run if any pane carries an agent or session;
  and a guard kills the instance if an agent CLI process shows up in its tree.
  The running Swarmterm is never touched: only processes descending from the
  npm process started here (and hosts first seen during the run) are sampled
  and, at the end, stopped.
  Builds without the dev-only hooks (release 1.22.1: no perf-mock-agent
  template, renderer stats or render counter) degrade: d and e use plain-shell
  panes running the generator, f reports the hook metrics as "unsupported".
  A failed, skipped or degraded scenario is listed at the top of summary.md
  with its reason; the Playwright output is kept as playwright-<s>-<n>.log.
  Results: test-results/perf-runs/<timestamp>/*.json and summary.md; compare
  two runs with scripts/perf/compare.ps1 -Base <run> -New <run>.

.EXAMPLE
  pwsh scripts/perf/flood.ps1                       # all scenarios x 3 runs, defaults
  pwsh scripts/perf/flood.ps1 -Scenario a -Panes 4 -SizeMB 50
  pwsh scripts/perf/flood.ps1 -Scenario d -AgentPanes 15 -AgentSeconds 150
  pwsh scripts/perf/flood.ps1 -Scenario g -ToolPanes 6 -ToolSeconds 75
#>
[CmdletBinding()]
param(
  # 'all' is a, b and c; d (agents, ~3 min per run), e and f are run on their
  # own; 'full' runs a, b, c, d (mock agents), e, f and g once each.
  [ValidateSet('a', 'b', 'c', 'd', 'e', 'f', 'g', 'all', 'full')] [string]$Scenario = 'all',
  [switch]$HostMode,
  [switch]$MockAgents,
  [ValidateRange(1, 5)] [int]$WarPairs = 4,
  [ValidateRange(0, 4)] [int]$StreamPanes = 4,
  [ValidateRange(16, 20)] [int]$VisiblePanes = 16,
  [ValidateRange(1, 30)] [int]$SwitchSeconds = 3,
  [ValidateRange(1, 11)] [int]$Panes = 4,
  [ValidateRange(1, 40)] [int]$AgentPanes = 15,
  [ValidateRange(10, 1800)] [int]$AgentSeconds = 150,
  [ValidateRange(1, 11)] [int]$ToolPanes = 6,
  [ValidateRange(1, 4)] [int]$ToolIdle = 2,
  [ValidateRange(10, 600)] [int]$ToolSeconds = 75,
  # Defaults keep a full a+b+c x 3 run to a few minutes; single runs are too
  # noisy to compare (see docs/perf-baseline.md), so each scenario repeats.
  [int]$SizeMB = 50,
  [int]$TuiSizeMB = 20,
  [ValidateRange(1, 20)] [int]$Repeat = 3,
  [int]$CdpPort = 9333,
  [int]$TimeoutSeconds = 600,
  # tauri:dev:no-speech is the isolated instance without whisper (machine rule:
  # no LLVM). tauri:dev:isolated works too where LLVM is available.
  [ValidateSet('tauri:dev:no-speech', 'tauri:dev:isolated')] [string]$DevScript = 'tauri:dev:no-speech',
  [switch]$Trace,
  [switch]$KeepRunning
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
$dataDir = Join-Path $env:TEMP 'swarmterm-perf'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $repo "test-results/perf-runs/$stamp"
New-Item -ItemType Directory -Force $dataDir, $outDir | Out-Null

# ---------- data generation ----------
function New-SeqFile([string]$path, [long]$bytes) {
  # 48-byte lines "S########|<filler>\r\n": short enough to fit any pane, so
  # ConPTY never wraps a sequence token.
  $lineLen = 48
  $lines = [long][math]::Floor($bytes / $lineLen)
  if ((Test-Path $path) -and (Get-Item $path).Length -eq $lines * $lineLen) { return $lines }
  Write-Host "generating $path ($lines lines)"
  $fill = 'abcdefghijklmnopqrstuvwxyz0123456789'
  $w = [IO.StreamWriter]::new($path, $false, [Text.UTF8Encoding]::new($false), 1MB)
  try {
    for ($i = 0L; $i -lt $lines; $i++) { $w.Write('S'); $w.Write($i.ToString('D8')); $w.Write('|'); $w.Write($fill); $w.Write("`r`n") }
  } finally { $w.Dispose() }
  return $lines
}

function New-TuiFile([string]$path, [long]$bytes) {
  if ((Test-Path $path) -and [math]::Abs((Get-Item $path).Length - $bytes) -lt 64KB) { return }
  Write-Host "generating $path"
  $e = [char]27
  $w = [IO.StreamWriter]::new($path, $false, [Text.UTF8Encoding]::new($false), 1MB)
  $rnd = [Random]::new(42)
  try {
    $f = 0
    while ($w.BaseStream.Length -lt $bytes) {
      # One htop-like frame: home, 24 rows of 256-colour/truecolour cells with
      # absolute cursor positioning, a bar graph, erase-to-EOL, then reset.
      $sb = [Text.StringBuilder]::new()
      [void]$sb.Append("$e[?25l$e[H")
      for ($r = 1; $r -le 24; $r++) {
        [void]$sb.Append("$e[$r;1H$e[1;38;5;$($rnd.Next(16,231))m$('{0,3}' -f $r)$e[0m ")
        $bar = $rnd.Next(1, 40)
        [void]$sb.Append("$e[48;2;$($rnd.Next(256));$($rnd.Next(80));$($rnd.Next(256))m" + ('|' * $bar) + "$e[0m$e[K")
        [void]$sb.Append("$e[$r;50H$e[3;4;38;2;200;$($rnd.Next(256));90mF$($f.ToString('D8'))$e[0m")
      }
      [void]$sb.Append("$e[?25h")
      $w.Write($sb.ToString()); $w.Flush(); $f++
    }
  } finally { $w.Dispose() }
}

# ---------- agent guard ----------
# Agent CLIs by executable name, and node-hosted ones by their package path in
# the command line (Claude Code, Codex, Gemini CLI and OpenCode run under node).
$agentNamePattern = '^(claude|codex|gemini|opencode|aider|goose|qwen|crush|cursor-agent|amp|copilot)(\.exe|\.cmd)?$'
$agentCmdPattern = '@anthropic-ai[\\/]claude-code|@openai[\\/]codex|@google[\\/]gemini-cli|opencode-ai|[\\/]claude(\.exe)?["\s]|[\\/]codex(\.exe)?["\s]'

# Polls the instance's tree every 200 ms (Win32_ProcessStartTrace events would
# be instant but need an elevated shell, and this harness runs unelevated); on
# an agent CLI it writes the
# offender to $flag and kills the whole instance, so the run fails at once.
# It also records every dev host seen (pid + start time), so the cleanup can
# stop exactly those and nothing that reuses a PID or path.
function Start-Guard([int]$rootPid, [string]$hostExe, [int[]]$foreignHosts, [string]$flag, [string]$hostLog) {
  Start-ThreadJob -ArgumentList $rootPid, ${function:Get-Tree}.ToString(), $hostExe, $foreignHosts, $flag, $hostLog, $agentNamePattern, $agentCmdPattern -ScriptBlock {
    param($rootPid, $treeSrc, $hostExe, $foreignHosts, $flag, $hostLog, $namePat, $cmdPat)
    ${function:Get-Tree} = [ScriptBlock]::Create($treeSrc)
    $seen = @{}
    while ($true) {
      foreach ($p in (Get-Tree $rootPid $hostExe $foreignHosts)) {
        if ($p.Name -eq 'swarmterm-host.exe' -and -not $seen.ContainsKey([int]$p.ProcessId)) {
          $seen[[int]$p.ProcessId] = 1
          try { "$($p.ProcessId),$((Get-Process -Id $p.ProcessId -ErrorAction Stop).StartTime.Ticks)" | Add-Content $hostLog } catch { }
        }
        if ($p.Name -match $namePat -or $p.CommandLine -match $cmdPat) {
          "$($p.ProcessId) $($p.Name) $($p.CommandLine)" | Set-Content $flag
          & taskkill.exe /PID $rootPid /T /F | Out-Null
          foreach ($h in $seen.Keys) { & taskkill.exe /PID $h /T /F | Out-Null }
          return
        }
      }
      Start-Sleep -Milliseconds 200
    }
  }
}

# ---------- process sampling ----------
function Get-Tree([int]$rootPid, [string]$hostExe, [int[]]$foreignHosts) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
  $set = [Collections.Generic.HashSet[int]]::new(); [void]$set.Add($rootPid)
  # Our dev host (see below) and everything under it: with -HostMode the
  # shells and whatever they start descend from the host, not from npm, and
  # the agent guard must see them too.
  foreach ($p in $all) { if ($p.ExecutablePath -eq $hostExe -and [int]$p.ProcessId -notin $foreignHosts) { [void]$set.Add([int]$p.ProcessId) } }
  do { $added = 0; foreach ($p in $all) { if ($set.Contains([int]$p.ParentProcessId) -and $set.Add([int]$p.ProcessId)) { $added++ } } } while ($added)
  # The terminal host is launched with CREATE_BREAKAWAY_FROM_JOB and is not a
  # child in this tree. Ours is this worktree's dev binary (the installed app's
  # host lives under AppData) and was not running before the run started.
  $all | Where-Object { $set.Contains([int]$_.ProcessId) -or ($_.ExecutablePath -eq $hostExe -and [int]$_.ProcessId -notin $foreignHosts) }
}

function Get-DevHostPids([string]$hostExe) {
  @(Get-CimInstance Win32_Process -Filter "Name = 'swarmterm-host.exe'" | Where-Object ExecutablePath -EQ $hostExe | ForEach-Object { [int]$_.ProcessId })
}

function Start-Sampler([int]$rootPid, [string]$csv, [string]$hostExe, [int[]]$foreignHosts) {
  Start-ThreadJob -ArgumentList $rootPid, $csv, ${function:Get-Tree}.ToString(), $hostExe, $foreignHosts -ScriptBlock {
    param($rootPid, $csv, $treeSrc, $hostExe, $foreignHosts)
    ${function:Get-Tree} = [ScriptBlock]::Create($treeSrc)
    $cores = [Environment]::ProcessorCount
    "epochMs,group,cpuPct,privateMB" | Set-Content $csv
    $prev = @{}
    $i = 0
    while ($true) {
      # The WMI walk is the slow part; the tree only changes when panes spawn.
      if ($i++ % 10 -eq 0) { $tree = Get-Tree $rootPid $hostExe $foreignHosts }
      $groups = @{ app = @(); host = @(); webview = @() }
      foreach ($p in $tree) {
        $g = switch -regex ($p.Name) { '^swarmterm\.exe$' { 'app' } '^swarmterm-host\.exe$' { 'host' } '^msedgewebview2\.exe$' { 'webview' } default { $null } }
        if ($g) { $groups[$g] += [int]$p.ProcessId }
      }
      $now = Get-Date
      $epoch = [DateTimeOffset]::new($now).ToUnixTimeMilliseconds()
      foreach ($g in $groups.Keys) {
        $cpu = 0.0; $mem = 0L; $complete = $true
        foreach ($id in $groups[$g]) {
          # A pooled WebView2 process can exit between the lookup and the read.
          try {
            $pr = Get-Process -Id $id -ErrorAction Stop
            $pm = $pr.PrivateMemorySize64; $tot = $pr.TotalProcessorTime.TotalMilliseconds
          } catch { continue }
          $mem += $pm
          $key = "$id"
          # A process's first reading has no delta: leave the CPU cell empty
          # rather than record a false 0.
          if ($prev.ContainsKey($key)) { $dt = ($now - $prev[$key].t).TotalMilliseconds; if ($dt -gt 0) { $cpu += 100 * ($tot - $prev[$key].cpu) / $dt / $cores } } else { $complete = $false }
          $prev[$key] = @{ t = $now; cpu = $tot }
        }
        if (-not $groups[$g].Count) { continue }
        $cpuCell = if ($complete) { $cpu.ToString('F1', [Globalization.CultureInfo]::InvariantCulture) } else { '' }
        [string]::Format([Globalization.CultureInfo]::InvariantCulture, "{0},{1},{2},{3:F1}", $epoch, $g, $cpuCell, ($mem / 1MB)) | Add-Content $csv
      }
      Start-Sleep -Milliseconds 1000
    }
  }
}

# Stats over the flood window only (epoch ms from the driver's result).
function Get-Stats([string]$csv, [long]$startMs, [long]$endMs) {
  $rows = @(Import-Csv $csv | Where-Object { [long]$_.epochMs -ge $startMs -and [long]$_.epochMs -le $endMs })
  foreach ($g in 'app', 'host', 'webview') {
    $r = @($rows | Where-Object group -EQ $g)
    if (-not $r.Count) { continue }
    $cpu = @($r | Where-Object cpuPct -NE '' | ForEach-Object { [double]$_.cpuPct } | Sort-Object)
    $mem = @($r | ForEach-Object { [double]$_.privateMB })
    [pscustomobject]@{
      group = $g; samples = $r.Count
      cpuAvg = if ($cpu.Count) { [math]::Round(($cpu | Measure-Object -Average).Average, 1) } else { $null }
      cpuP95 = if ($cpu.Count) { $cpu[[math]::Min($cpu.Count - 1, [int][math]::Floor(0.95 * $cpu.Count))] } else { $null }
      memStartMB = [math]::Round($mem[0], 0); memMaxMB = [math]::Round(($mem | Measure-Object -Maximum).Maximum, 0); memEndMB = [math]::Round($mem[-1], 0)
    }
  }
}

# ---------- run ----------
$seqFile = Join-Path $dataDir "seq-$SizeMB.txt"
$tuiFile = Join-Path $dataDir "tui-$TuiSizeMB.txt"
$seqLines = New-SeqFile $seqFile ([long]$SizeMB * 1MB)
if ($Scenario -in 'b', 'all', 'full') { New-TuiFile $tuiFile ([long]$TuiSizeMB * 1MB) }
$agentScript = Join-Path $PSScriptRoot 'agent-stream.mjs'
# The perf-mock-agent template runs `node agent-stream.mjs --mock` in the pane's
# cwd (the data dir): refresh that copy from this checkout every run.
Copy-Item $agentScript (Join-Path $dataDir 'agent-stream.mjs') -Force
$toolScript = Join-Path $PSScriptRoot 'tool-agent.mjs'
if ($Scenario -eq 'full') { $Repeat = 1; $MockAgents = $true }
if ($HostMode) {
  # tauri dev builds only the app; the host binary is a separate package.
  Push-Location $repo
  try { cargo build -p swarmterm-host --manifest-path src-tauri/Cargo.toml 2>&1 | Select-Object -Last 1 | Write-Host; if ($LASTEXITCODE) { throw "cargo build -p swarmterm-host failed" } } finally { Pop-Location }
}

if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
  throw "port 1420 is already in use (another dev server?). Stop it first; the running Swarmterm is not affected by this script."
}
# The CDP port only has to be free: take the next free one.
$want = $CdpPort
while (Get-NetTCPConnection -LocalPort $CdpPort -State Listen -ErrorAction SilentlyContinue) { if (++$CdpPort -gt $want + 50) { throw "no free CDP port in $want-$($want + 50)" } }
if ($CdpPort -ne $want) { Write-Host "CDP port $want is busy, using $CdpPort" }

# Fresh, empty profile for every instance: its own identifier (so neither
# the user's app nor the shared dev profile com.apooooh.swarmterm.gn.dev is
# used) with app data and WebView2 data (localStorage, saved workspaces)
# deleted first. Nothing can be restored, so no agent session can resume.
$perfId = 'com.apooooh.swarmterm.gn.perf'
$perfConf = Join-Path $outDir 'tauri.perf.conf.json'
@{ identifier = $perfId; productName = 'Swarmterm GN Perf' } | ConvertTo-Json | Set-Content $perfConf
foreach ($d in (Join-Path $env:APPDATA $perfId), (Join-Path $env:LOCALAPPDATA $perfId)) {
  if (Test-Path $d) { Remove-Item -Recurse -Force -LiteralPath $d }
  if (Test-Path $d) { throw "could not clear perf profile $d (instance still running?)" }
}
$features = if ($DevScript -eq 'tauri:dev:no-speech') { ' -- --no-default-features' } else { '' }

$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo 'src-tauri\target' }
$hostExe = Join-Path $targetDir 'debug\swarmterm-host.exe'
# Dev hosts of this worktree that already run belong to someone else: never
# sample or stop them.
$foreignHosts = Get-DevHostPids $hostExe
if ($foreignHosts.Count -and $HostMode) { throw "dev host(s) $($foreignHosts -join ', ') from $hostExe already run; -HostMode would attach to a host this run did not start. Stop them first." }
if ($foreignHosts.Count) { Write-Warning "dev host(s) $($foreignHosts -join ', ') from $hostExe already run (leaked from an earlier run?); they are excluded, so the host row will be empty. Stop them first for host numbers." }

# Only the new instance reads this: WebView2 picks it up at browser start.
# Restore the caller's value afterwards instead of clearing it.
$prevWv2Args = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = (@($prevWv2Args, "--remote-debugging-port=$CdpPort") | Where-Object { $_ }) -join ' '
$log = Join-Path $outDir 'dev.log'
try {
  $npm = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', "npx tauri dev --config `"$perfConf`"$features > `"$log`" 2>&1" -WorkingDirectory $repo -PassThru -WindowStyle Hidden
} finally {
  if ($null -eq $prevWv2Args) { Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue } else { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $prevWv2Args }
}
$npmStart = $npm.StartTime
Write-Host "dev instance starting (pid $($npm.Id)), log $log"

try {
  $deadline = (Get-Date).AddMinutes(15)
  do {
    Start-Sleep 3
    if ($npm.HasExited) { throw "dev instance exited; see $log" }
    $ok = try { (Invoke-RestMethod "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 2) | Where-Object url -Match '1420' } catch { $null }
  } until ($ok -or (Get-Date) -gt $deadline)
  if (-not $ok) { throw "CDP endpoint did not come up; see $log" }
  Start-Sleep 5

  $plan = switch ($Scenario) { 'all' { 'a', 'b', 'c' } 'full' { 'a', 'b', 'c', 'd', 'e', 'f', 'g' } default { $Scenario } }
  $flag = Join-Path $outDir 'AGENT-DETECTED.txt'
  $hostLog = Join-Path $outDir 'hosts.txt'
  $guard = Start-Guard $npm.Id $hostExe $foreignHosts $flag $hostLog
  $results = @()
  $abort = $null
  foreach ($s in $plan) { foreach ($rep in 1..$Repeat) {
    # A run aborted by the agent guard skips everything after it, reported.
    if ($abort) { $results += [pscustomobject]@{ scenario = $s; run = $rep; status = 'skipped'; reason = "run aborted earlier: $abort"; wallSeconds = $null; proc = @(); webview = $null }; continue }
    $cfg = switch ($s) {
      'a' { @{ flood = $Panes; idle = 1; file = $seqFile; lines = $seqLines } }
      'b' { @{ flood = $Panes; idle = 1; file = $tuiFile; lines = 0 } }
      'c' { @{ flood = 4; idle = 20; file = $seqFile; lines = $seqLines } }
      'd' { @{ flood = $AgentPanes; idle = 1; file = $agentScript; lines = 0 } }
      'e' { @{ flood = $StreamPanes; idle = 2 * $WarPairs; file = $agentScript; lines = 0 } }
      'f' { @{ flood = $VisiblePanes + 8; idle = 0; file = $agentScript; lines = 0 } }
      'g' { @{ flood = $ToolPanes; idle = $ToolIdle; file = $toolScript; lines = 0 } }
    }
    $env:PERF_HOST = if ($HostMode) { '1' } else { '' }
    $env:PERF_MOCK = if ($MockAgents) { '1' } else { '' }
    $env:PERF_WAR = $WarPairs; $env:PERF_STREAM = $StreamPanes; $env:PERF_VISIBLE = $VisiblePanes; $env:PERF_SWITCH_S = $SwitchSeconds
    Write-Host "scenario $s run $rep/$Repeat : $($cfg.flood) flooding + $($cfg.idle) idle"
    $csv = Join-Path $outDir "proc-$s-$rep.csv"; $json = Join-Path $outDir "webview-$s-$rep.json"
    $env:PERF_CDP = "http://127.0.0.1:$CdpPort"; $env:PERF_SCENARIO = $s
    $env:PERF_FLOOD = $cfg.flood; $env:PERF_IDLE = $cfg.idle; $env:PERF_FILE = $cfg.file; $env:PERF_LINES = $cfg.lines
    $env:PERF_CWD = $dataDir; $env:PERF_OUT = $json; $env:PERF_TIMEOUT_S = $TimeoutSeconds; $env:PERF_SECONDS = $(if ($s -eq 'g') { $ToolSeconds } else { $AgentSeconds })
    $env:PERF_TRACE = if ($Trace) { Join-Path $outDir "trace-$s-$rep.json" } else { '' }
    if (Test-Path $json) { Remove-Item $json }
    $pwLog = Join-Path $outDir "playwright-$s-$rep.log"
    $job = Start-Sampler $npm.Id $csv $hostExe $foreignHosts
    # Wall time of the whole scenario: Playwright start, setup, run, teardown.
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $exit = 0
    try {
      Push-Location $repo
      npx playwright test --config playwright.perf.config.ts --reporter=line *>&1 | Tee-Object -FilePath $pwLog | ForEach-Object { if ("$_" -match 'error|passed|failed|Timeout') { Write-Host $_ } }
      $exit = $LASTEXITCODE
      if ($exit) { Write-Warning "scenario $s driver failed (exit $exit), see $pwLog" }
    } finally {
      $sw.Stop()
      Pop-Location
      # Surface sampler failures instead of silently reporting empty stats.
      if ($job.State -eq 'Failed' -or $job.ChildJobs[0].Error.Count) { Write-Warning "sampler for scenario $s failed: $($job.ChildJobs[0].Error -join '; ') $($job.ChildJobs[0].JobStateInfo.Reason)" }
      Stop-Job $job; Remove-Job $job -Force
    }
    $wv = if (Test-Path $json) { Get-Content $json -Raw | ConvertFrom-Json } else { $null }
    # Status and reason: the spec writes its error into the result file; a
    # missing file or a non-zero exit without one falls back to the log.
    $status = 'ok'; $reason = $null
    if (Test-Path $flag) { $abort = "agent CLI detected in the instance: $((Get-Content $flag -Raw).Trim())"; $status = 'aborted'; $reason = $abort }
    elseif ($wv -and $wv.failed) { $status = 'failed'; $reason = (($wv.error -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 3) -join ' | ') }
    elseif (-not $wv -or $exit) {
      $status = 'failed'
      $err = if (Test-Path $pwLog) { @(Select-String -Path $pwLog -Pattern 'Error|error:|Timeout' | Select-Object -First 3 | ForEach-Object { $_.Line.Trim() }) } else { @() }
      $reason = "driver exit $exit, $(if ($wv) { 'result written' } else { 'no result file' })$(if ($err.Count) { ': ' + ($err -join ' | ') })"
    }
    if ($status -ne 'ok') { Write-Warning "scenario $s run ${rep}: $($status.ToUpper()): $reason" }
    $ok = $wv -and -not $wv.failed -and $null -ne $wv.windowStartMs
    # A run that failed only in teardown was still measured: keep its process
    # stats beside the error, but out of the medians (webview stays null).
    $proc = if ($wv -and $null -ne $wv.windowStartMs) { @(Get-Stats $csv $wv.windowStartMs $wv.windowEndMs) } else { @() }
    if ($ok -and -not ($proc | Where-Object group -EQ 'host')) { Write-Host "scenario ${s}: no terminal host sampled (host off in Settings > Terminal, or not at $hostExe)" }
    $results += [pscustomobject]@{ scenario = $s; run = $rep; status = $status; reason = $reason; wallSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); proc = $proc; webview = $(if ($ok) { $wv } else { $null }); error = $(if ($wv -and $wv.failed) { $wv } else { $null }) }
  } }
  $results | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $outDir 'summary.json')

  function Get-Median([double[]]$v) { if (-not $v.Count) { return $null }; $o = @($v | Sort-Object); if ($o.Count % 2) { $o[[int][math]::Floor($o.Count / 2)] } else { ($o[$o.Count / 2 - 1] + $o[$o.Count / 2]) / 2 } }
  # 'unsupported' (a hook this build lacks) wins over n/a: it is not missing data.
  function Get-Spread([object[]]$v) { if ($v | Where-Object { $_ -is [string] -and $_ -eq 'unsupported' }) { return 'unsupported' }; $n = @($v | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ }); if (-not $n.Count) { return 'n/a' }; "$(Get-Median $n) ($(($n | Measure-Object -Minimum).Minimum)-$(($n | Measure-Object -Maximum).Maximum))" }

  $md = @("# Perf run $stamp", '', "Panes: $Panes, seq file: $SizeMB MB ($seqLines lines), TUI file: $TuiSizeMB MB, $Repeat run(s) per scenario", '',
    "Backend: $(if ($HostMode) { 'terminal host (-HostMode)' } else { 'in-process PTY' }); scenario d agents: $(if ($MockAgents) { 'perf-mock-agent template (-MockAgents)' } else { 'plain shells running the generator' }). Simulation only: no agent CLI or AI provider.", '')
  # Loud first: anything that did not run clean. Medians below only use ok runs.
  $bad = @($results | Where-Object status -NE 'ok')
  if ($bad.Count) {
    $md += "## FAILED / SKIPPED: $($bad.Count) of $($results.Count) run(s)", '', '| scenario | run | status | reason |', '|---|---|---|---|'
    foreach ($r in $bad) { $md += "| $($r.scenario) | $($r.run) | **$($r.status.ToUpper())** | $(([string]$r.reason) -replace '\|', '/') |" }
    $md += ''
  }
  $notes = @($results | ForEach-Object { $r = $_; @($r.webview.notes) + @($r.error.notes) | Where-Object { $_ } | ForEach-Object { "- scenario $($r.scenario) run $($r.run): $_" } } | Select-Object -Unique)
  if ($notes.Count) { $md += '## Degraded on this build (fallbacks, unsupported metrics)', '' ; $md += $notes; $md += '' }
  # Timing of every run: wall = the whole Playwright run as seen here; setup,
  # run, teardown from the spec; output timing from the in-page probes.
  $md += '## Timings per run', '',
    '| scenario | run | status | wall s | setup s | run s | teardown s | stream s | first output ms | first parsed ms | all output parsed ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|'
  foreach ($r in $results) {
    $t = if ($r.webview) { $r.webview.timing } elseif ($r.error) { $r.error.timing } else { $null }
    $o = if ($r.webview) { $r.webview.outputTiming } else { $null }
    $c = { param($x) if ($null -eq $x) { 'n/a' } else { $x } }
    $md += "| $($r.scenario) | $($r.run) | $($r.status) | $(& $c $r.wallSeconds) | $(& $c $t.setupS) | $(& $c $t.runS) | $(& $c $t.teardownS) | $(& $c $o.streamSeconds) | $(& $c $o.firstOutputMs) | $(& $c $o.firstParsedMs) | $(& $c $o.allParsedMs) |"
  }
  $md += ''
  if ($results | Where-Object scenario -In 'a', 'b', 'c') {
    $md += '## Summary: median (min-max) over runs', '',
      '| scenario | echo p50 ms | echo p95 ms | echo max ms | frames > 50 ms | long tasks > 50 ms | app CPU avg % | WebView CPU avg % | WebView MB max (cumulative in instance) | lines lost | flood s |',
      '|---|---|---|---|---|---|---|---|---|---|---|'
  }
  foreach ($g in ($results | Group-Object scenario | Where-Object Name -NotIn 'd', 'e', 'f', 'g')) {
    $w = @($g.Group | ForEach-Object { $_.webview } | Where-Object { $_ })
    $pa = @($g.Group | ForEach-Object { $_.proc | Where-Object group -EQ 'app' })
    $pw = @($g.Group | ForEach-Object { $_.proc | Where-Object group -EQ 'webview' })
    # No stream (no S-token ever seen) or fewer streams than flood panes means
    # total loss in those panes, never n/a.
    $lost = if ($g.Name -eq 'b') { 'n/a' } else {
      $sum = ($w | ForEach-Object { ($_.streams | Measure-Object missingLines -Sum).Sum } | Measure-Object -Sum).Sum
      $short = @($w | Where-Object { @($_.streams).Count -lt $_.flood }).Count + ($Repeat - $w.Count)
      if ($short) { "$sum + $short run(s) with panes that delivered nothing" } else { $sum }
    }
    $md += "| $($g.Name) | $(Get-Spread ($w | % { $_.echo.p50 })) | $(Get-Spread ($w | % { $_.echo.p95 })) | $(Get-Spread ($w | % { $_.echo.max })) | $(Get-Spread ($w | % { $_.frames.over50 })) | $(Get-Spread ($w | % { $_.longTasks.over50 })) | $(Get-Spread ($pa | % { $_.cpuAvg })) | $(Get-Spread ($pw | % { $_.cpuAvg })) | $(Get-Spread ($pw | % { $_.memMaxMB })) | $lost | $(Get-Spread ($w | % { $_.floodSeconds })) |"
  }
  $md += ''
  $d = @($results | Where-Object scenario -EQ 'd')
  if ($d.Count) {
    $w = @($d | ForEach-Object { $_.webview } | Where-Object { $_ })
    $pa = @($d | ForEach-Object { $_.proc | Where-Object group -EQ 'app' })
    $pw = @($d | ForEach-Object { $_.proc | Where-Object group -EQ 'webview' })
    $md += "## Scenario d (agents): $AgentPanes agent panes x $AgentSeconds s + 1 idle, median (min-max) over runs", '',
      '| metric | value |', '|---|---|',
      "| echo idle pane p50 / p95 / max ms | $(Get-Spread ($w | % { $_.echo.p50 })) / $(Get-Spread ($w | % { $_.echo.p95 })) / $(Get-Spread ($w | % { $_.echo.max })) |",
      "| echo busy agent pane p50 / p95 / max ms | $(Get-Spread ($w | % { $_.echoBusy.p50 })) / $(Get-Spread ($w | % { $_.echoBusy.p95 })) / $(Get-Spread ($w | % { $_.echoBusy.max })) |",
      "| echo unanswered idle / busy | $(Get-Spread ($w | % { $_.echo.unanswered })) / $(Get-Spread ($w | % { $_.echoBusy.unanswered })) |",
      "| tool-dump lag at parse p50 / p95 / max ms | $(Get-Spread ($w | % { $_.lag.parseDump.p50 })) / $(Get-Spread ($w | % { $_.lag.parseDump.p95 })) / $(Get-Spread ($w | % { $_.lag.parseDump.max })) |",
      "| tool-dump lag at hand-over p50 / p95 / max ms | $(Get-Spread ($w | % { $_.lag.recvDump.p50 })) / $(Get-Spread ($w | % { $_.lag.recvDump.p95 })) / $(Get-Spread ($w | % { $_.lag.recvDump.max })) |",
      "| streamed-line lag at parse p50 / p95 / max ms | $(Get-Spread ($w | % { $_.lag.parse.p50 })) / $(Get-Spread ($w | % { $_.lag.parse.p95 })) / $(Get-Spread ($w | % { $_.lag.parse.max })) |",
      "| streamed-line lag at hand-over to xterm p50 / p95 / max ms | $(Get-Spread ($w | % { $_.lag.recv.p50 })) / $(Get-Spread ($w | % { $_.lag.recv.p95 })) / $(Get-Spread ($w | % { $_.lag.recv.max })) |",
      "| worst pane's streamed-line parse-lag p95 ms | $(Get-Spread ($w | % { $_.lag.worstPaneP95 })) |",
      "| panes with lag samples | $(Get-Spread ($w | % { $_.lag.panes })) |",
      "| frames > 50 ms / long tasks > 50 ms | $(Get-Spread ($w | % { $_.frames.over50 })) / $(Get-Spread ($w | % { $_.longTasks.over50 })) |",
      "| frame p95 / p99 ms | $(Get-Spread ($w | % { $_.frames.p95 })) / $(Get-Spread ($w | % { $_.frames.p99 })) |",
      "| app CPU avg % | $(Get-Spread ($pa | % { $_.cpuAvg })) |",
      "| WebView CPU avg / p95 % | $(Get-Spread ($pw | % { $_.cpuAvg })) / $(Get-Spread ($pw | % { $_.cpuP95 })) |",
      "| WebView MB start / max / end | $(Get-Spread ($pw | % { $_.memStartMB })) / $(Get-Spread ($pw | % { $_.memMaxMB })) / $(Get-Spread ($pw | % { $_.memEndMB })) |",
      "| app MB max | $(Get-Spread ($pa | % { $_.memMaxMB })) |",
      "| host CPU avg % / MB max | $(Get-Spread ($d | % { $_.proc | Where-Object group -EQ 'host' } | % { $_.cpuAvg })) / $(Get-Spread ($d | % { $_.proc | Where-Object group -EQ 'host' } | % { $_.memMaxMB })) |",
      "| WorkspaceTabs / AttentionBadge renders | $(Get-Spread ($w | % { $_.renders.WorkspaceTabs })) / $(Get-Spread ($w | % { $_.renders.AttentionBadge })) |", ''
  }
  $er = @($results | Where-Object scenario -EQ 'e')
  if ($er.Count) {
    $w = @($er | ForEach-Object { $_.webview } | Where-Object { $_ })
    $pa = @($er | ForEach-Object { $_.proc | Where-Object group -EQ 'app' })
    $md += "## Scenario e (War Room): $WarPairs mock peers + $WarPairs waiters, $StreamPanes streaming, $AgentSeconds s", '',
      '| metric | value |', '|---|---|',
      "| wait_peer resolve p50 / p95 / max ms | $(Get-Spread ($w | % { $_.warRoom.resolve.p50 })) / $(Get-Spread ($w | % { $_.warRoom.resolve.p95 })) / $(Get-Spread ($w | % { $_.warRoom.resolve.max })) |",
      "| calls / reached / timeout / stalled / errors | $(Get-Spread ($w | % { $_.warRoom.calls })) / $(Get-Spread ($w | % { $_.warRoom.reached })) / $(Get-Spread ($w | % { $_.warRoom.timeout })) / $(Get-Spread ($w | % { $_.warRoom.stalled })) / $(Get-Spread ($w | % { $_.warRoom.errors })) |",
      "| idle flips / reached without a matching flip | $(Get-Spread ($w | % { $_.warRoom.idleFlips })) / $(Get-Spread ($w | % { $_.warRoom.unmatched })) |",
      "| app CPU avg / p95 % | $(Get-Spread ($pa | % { $_.cpuAvg })) / $(Get-Spread ($pa | % { $_.cpuP95 })) |",
      "| echo idle waiter p95 ms | $(Get-Spread ($w | % { $_.echo.p95 })) |", ''
    foreach ($x in $w) { if ($x.warRoom.firstError) { $md += "- first wait_peer error: $($x.warRoom.firstError)", '' } }
  }
  $fr = @($results | Where-Object scenario -EQ 'f')
  if ($fr.Count) {
    $w = @($fr | ForEach-Object { $_.webview } | Where-Object { $_ })
    $pw = @($fr | ForEach-Object { $_.proc | Where-Object group -EQ 'webview' })
    $md += "## Scenario f (many visible): $VisiblePanes visible + 2 x 4, switch every $SwitchSeconds s, $AgentSeconds s", '',
      '| metric | value |', '|---|---|',
      "| main workspace visible panes / live WebGL max / DOM fallback max | $(Get-Spread ($w | % { $_.renderers.mainVisible })) / $(Get-Spread ($w | % { $_.renderers.mainWebglMax })) / $(Get-Spread ($w | % { $_.renderers.mainDomFallbackMax })) |",
      "| live WebGL contexts max (any workspace) / DOM fallback max | $(Get-Spread ($w | % { $_.renderers.webglMax })) / $(Get-Spread ($w | % { $_.renderers.domFallbackMax })) |",
      "| switches | $(Get-Spread ($w | % { $_.renderers.switches })) |",
      "| frames > 50 ms / long tasks > 50 ms | $(Get-Spread ($w | % { $_.frames.over50 })) / $(Get-Spread ($w | % { $_.longTasks.over50 })) |",
      "| WebView CPU avg % / MB max | $(Get-Spread ($pw | % { $_.cpuAvg })) / $(Get-Spread ($pw | % { $_.memMaxMB })) |", ''
  }
  $gr = @($results | Where-Object scenario -EQ 'g')
  if ($gr.Count) {
    $w = @($gr | ForEach-Object { $_.webview } | Where-Object { $_ })
    $pa = @($gr | ForEach-Object { $_.proc | Where-Object group -EQ 'app' })
    $pw = @($gr | ForEach-Object { $_.proc | Where-Object group -EQ 'webview' })
    $md += "## Scenario g (tool-heavy agents): $ToolPanes tool panes + $ToolIdle idle, $ToolSeconds s", '',
      '| metric | value |', '|---|---|',
      "| echo idle pane p50 / p95 / max ms | $(Get-Spread ($w | % { $_.echo.p50 })) / $(Get-Spread ($w | % { $_.echo.p95 })) / $(Get-Spread ($w | % { $_.echo.max })) |",
      "| cmd spawns / round trip p50 / p95 / max ms | $(Get-Spread ($w | % { $_.tools.spawnCmd.count })) / $(Get-Spread ($w | % { $_.tools.spawnCmd.p50 })) / $(Get-Spread ($w | % { $_.tools.spawnCmd.p95 })) / $(Get-Spread ($w | % { $_.tools.spawnCmd.max })) |",
      "| pwsh spawns / round trip p50 / p95 ms | $(Get-Spread ($w | % { $_.tools.spawnPwsh.count })) / $(Get-Spread ($w | % { $_.tools.spawnPwsh.p50 })) / $(Get-Spread ($w | % { $_.tools.spawnPwsh.p95 })) |",
      "| 200 KB type spawns / round trip p50 / p95 ms | $(Get-Spread ($w | % { $_.tools.spawnBigOutput.count })) / $(Get-Spread ($w | % { $_.tools.spawnBigOutput.p50 })) / $(Get-Spread ($w | % { $_.tools.spawnBigOutput.p95 })) |",
      "| failed spawns / file ops / storms | $(Get-Spread ($w | % { $_.tools.spawnFailed })) / $(Get-Spread ($w | % { $_.tools.fileOps })) / $(Get-Spread ($w | % { $_.tools.storms })) |",
      "| file events / rescans | $(Get-Spread ($w | % { $_.tools.fileEvents })) / $(Get-Spread ($w | % { $_.tools.rescans })) |",
      "| storm-to-event latency p50 / p95 / max ms | $(Get-Spread ($w | % { $_.tools.fileEventLatency.p50 })) / $(Get-Spread ($w | % { $_.tools.fileEventLatency.p95 })) / $(Get-Spread ($w | % { $_.tools.fileEventLatency.max })) |",
      "| storms seen / via rescan / missed (5 s) | $(Get-Spread ($w | % { $_.tools.fileEventLatency.samples })) / $(Get-Spread ($w | % { $_.tools.fileEventLatency.viaRescan })) / $(Get-Spread ($w | % { $_.tools.fileEventLatency.missed })) |",
      "| frame p95 / p99 ms / frames > 50 ms / long tasks > 50 ms | $(Get-Spread ($w | % { $_.frames.p95 })) / $(Get-Spread ($w | % { $_.frames.p99 })) / $(Get-Spread ($w | % { $_.frames.over50 })) / $(Get-Spread ($w | % { $_.longTasks.over50 })) |",
      "| app CPU avg % | $(Get-Spread ($pa | % { $_.cpuAvg })) |",
      "| WebView CPU avg / p95 % / MB max | $(Get-Spread ($pw | % { $_.cpuAvg })) / $(Get-Spread ($pw | % { $_.cpuP95 })) / $(Get-Spread ($pw | % { $_.memMaxMB })) |", ''
  }
  foreach ($r in $results) {
    $w = $r.webview
    $md += "## Scenario $($r.scenario), run $($r.run)", '', '| process | CPU avg % | CPU p95 % | private MB start / max / end |', '|---|---|---|---|'
    foreach ($p in $r.proc) { $md += "| $($p.group) | $($p.cpuAvg) | $($p.cpuP95) | $($p.memStartMB) / $($p.memMaxMB) / $($p.memEndMB) |" }
    if ($w) {
      $md += '', "- flood: $($w.floodSeconds) s (wall $([math]::Round($w.wallSeconds)) s, window hidden $($w.hiddenMs) ms, longest output gap $($w.maxOutputGapMs) ms)",
        "- echo latency ms: p50 $($w.echo.p50), p95 $($w.echo.p95), max $($w.echo.max) ($($w.echo.samples) samples, $($w.echo.unanswered) unanswered)",
        "- long tasks: $($w.longTasks.count) (over 50 ms: $($w.longTasks.over50), total $($w.longTasks.totalMs) ms, max $($w.longTasks.max) ms)",
        "- frame ms: p50 $($w.frames.p50), p95 $($w.frames.p95), p99 $($w.frames.p99), max $($w.frames.max) (over 50 ms: $($w.frames.over50) of $($w.frames.count))"
      if ($w.lag) {
        $md += "- echo busy pane ms: p50 $($w.echoBusy.p50), p95 $($w.echoBusy.p95), max $($w.echoBusy.max) ($($w.echoBusy.samples) samples, $($w.echoBusy.unanswered) unanswered)",
          "- delivery lag ms ($($w.lag.parse.samples) tokens, $($w.lag.panes) panes, $($w.lag.repaintTokens) repainted): parse p50 $($w.lag.parse.p50) p95 $($w.lag.parse.p95) max $($w.lag.parse.max); hand-over p50 $($w.lag.recv.p50) p95 $($w.lag.recv.p95) max $($w.lag.recv.max); worst pane p95 $($w.lag.worstPaneP95); dumps ($($w.lag.parseDump.samples) tokens) parse p50 $($w.lag.parseDump.p50) p95 $($w.lag.parseDump.p95) max $($w.lag.parseDump.max), hand-over p95 $($w.lag.recvDump.p95)"
      }
      foreach ($st in $w.streams) { $md += "- line integrity: seen $($st.seen) lines, missing $($st.missingLines), gaps $($st.gaps), dupes $($st.dupes), unparsed chars $($st.charsUnparsed), hashOk $($st.hashOk)" }
    }
    $md += ''
  }
  $md -join "`n" | Set-Content (Join-Path $outDir 'summary.md')
  Write-Host ($md -join "`n")
  Write-Host "results in $outDir"
  if ($abort) { throw "run aborted: $abort" }
} finally {
  if ($guard) { Stop-Job $guard; Remove-Job $guard -Force }
  if (-not $KeepRunning) {
    # Stop only what this run started; the user's Swarmterm is in neither set.
    # The StartTime check guards against a recycled PID.
    $live = Get-Process -Id $npm.Id -ErrorAction SilentlyContinue
    if ($live -and $live.StartTime -eq $npmStart) { & taskkill.exe /PID $npm.Id /T /F | Out-Null }
    # Hosts: only those the guard saw start during this run, matched by PID
    # AND start time, so a recycled PID or another checkout's host is safe.
    if ($hostLog -and (Test-Path $hostLog)) {
      foreach ($line in (Get-Content $hostLog)) {
        $id, $ticks = $line -split ','
        $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
        if ($p -and $p.StartTime.Ticks -eq [long]$ticks -and [int]$id -notin $foreignHosts) { & taskkill.exe /PID $id /T /F | Out-Null }
      }
    }
  }
}

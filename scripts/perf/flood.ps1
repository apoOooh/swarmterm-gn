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
  The running Swarmterm is never touched: only processes descending from the
  npm process started here are sampled and, at the end, stopped.
  Results: test-results/perf-runs/<timestamp>/*.json and summary.md.

.EXAMPLE
  pwsh scripts/perf/flood.ps1                       # all scenarios x 3 runs, defaults
  pwsh scripts/perf/flood.ps1 -Scenario a -Panes 4 -SizeMB 50
#>
[CmdletBinding()]
param(
  [ValidateSet('a', 'b', 'c', 'all')] [string]$Scenario = 'all',
  [ValidateRange(1, 11)] [int]$Panes = 4,
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

# ---------- process sampling ----------
function Get-Tree([int]$rootPid, [string]$hostExe, [int[]]$foreignHosts) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath
  $set = [Collections.Generic.HashSet[int]]::new(); [void]$set.Add($rootPid)
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
if ($Scenario -in 'b', 'all') { New-TuiFile $tuiFile ([long]$TuiSizeMB * 1MB) }

if (Get-NetTCPConnection -LocalPort 1420, $CdpPort -State Listen -ErrorAction SilentlyContinue) {
  throw "port 1420 or $CdpPort is already in use (another dev server?). Stop it first; the running Swarmterm is not affected by this script."
}

$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo 'src-tauri\target' }
$hostExe = Join-Path $targetDir 'debug\swarmterm-host.exe'
# Dev hosts of this worktree that already run belong to someone else: never
# sample or stop them.
$foreignHosts = Get-DevHostPids $hostExe
if ($foreignHosts.Count) { Write-Warning "dev host(s) $($foreignHosts -join ', ') from $hostExe already run (leaked from an earlier run?); they are excluded, so the host row will be empty. Stop them first for host numbers." }

# Only the new instance reads this: WebView2 picks it up at browser start.
# Restore the caller's value afterwards instead of clearing it.
$prevWv2Args = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = (@($prevWv2Args, "--remote-debugging-port=$CdpPort") | Where-Object { $_ }) -join ' '
$log = Join-Path $outDir 'dev.log'
try {
  $npm = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', "npm run $DevScript > `"$log`" 2>&1" -WorkingDirectory $repo -PassThru -WindowStyle Hidden
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

  $plan = switch ($Scenario) { 'all' { 'a', 'b', 'c' } default { $Scenario } }
  $results = @()
  foreach ($s in $plan) { foreach ($rep in 1..$Repeat) {
    $cfg = switch ($s) {
      'a' { @{ flood = $Panes; idle = 1; file = $seqFile; lines = $seqLines } }
      'b' { @{ flood = $Panes; idle = 1; file = $tuiFile; lines = 0 } }
      'c' { @{ flood = 4; idle = 20; file = $seqFile; lines = $seqLines } }
    }
    Write-Host "scenario $s run $rep/$Repeat : $($cfg.flood) flooding + $($cfg.idle) idle"
    $csv = Join-Path $outDir "proc-$s-$rep.csv"; $json = Join-Path $outDir "webview-$s-$rep.json"
    $env:PERF_CDP = "http://127.0.0.1:$CdpPort"; $env:PERF_SCENARIO = $s
    $env:PERF_FLOOD = $cfg.flood; $env:PERF_IDLE = $cfg.idle; $env:PERF_FILE = $cfg.file; $env:PERF_LINES = $cfg.lines
    $env:PERF_CWD = $dataDir; $env:PERF_OUT = $json; $env:PERF_TIMEOUT_S = $TimeoutSeconds
    $env:PERF_TRACE = if ($Trace) { Join-Path $outDir "trace-$s-$rep.json" } else { '' }
    if (Test-Path $json) { Remove-Item $json }
    $job = Start-Sampler $npm.Id $csv $hostExe $foreignHosts
    try {
      Push-Location $repo
      npx playwright test --config playwright.perf.config.ts --reporter=line
      if ($LASTEXITCODE) { Write-Warning "scenario $s driver failed (exit $LASTEXITCODE)" }
    } finally {
      Pop-Location
      # Surface sampler failures instead of silently reporting empty stats.
      if ($job.State -eq 'Failed' -or $job.ChildJobs[0].Error.Count) { Write-Warning "sampler for scenario $s failed: $($job.ChildJobs[0].Error -join '; ') $($job.ChildJobs[0].JobStateInfo.Reason)" }
      Stop-Job $job; Remove-Job $job -Force
    }
    $wv = if (Test-Path $json) { Get-Content $json -Raw | ConvertFrom-Json } else { $null }
    $proc = if ($wv) { @(Get-Stats $csv $wv.windowStartMs $wv.windowEndMs) } else { @() }
    if ($wv -and -not ($proc | Where-Object group -EQ 'host')) { Write-Host "scenario ${s}: no terminal host sampled (host off in Settings > Terminal, or not at $hostExe)" }
    $results += [pscustomobject]@{ scenario = $s; run = $rep; proc = $proc; webview = $wv }
  } }
  $results | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $outDir 'summary.json')

  function Get-Median([double[]]$v) { if (-not $v.Count) { return $null }; $o = @($v | Sort-Object); if ($o.Count % 2) { $o[[int][math]::Floor($o.Count / 2)] } else { ($o[$o.Count / 2 - 1] + $o[$o.Count / 2]) / 2 } }
  function Get-Spread([object[]]$v) { $n = @($v | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ }); if (-not $n.Count) { return 'n/a' }; "$(Get-Median $n) ($(($n | Measure-Object -Minimum).Minimum)-$(($n | Measure-Object -Maximum).Maximum))" }

  $md = @("# Perf run $stamp", '', "Panes: $Panes, seq file: $SizeMB MB ($seqLines lines), TUI file: $TuiSizeMB MB, $Repeat run(s) per scenario", '',
    '## Summary: median (min-max) over runs', '',
    '| scenario | echo p50 ms | echo p95 ms | echo max ms | frames > 50 ms | long tasks > 50 ms | app CPU avg % | WebView CPU avg % | WebView MB max (cumulative in instance) | lines lost | flood s |',
    '|---|---|---|---|---|---|---|---|---|---|---|')
  foreach ($g in ($results | Group-Object scenario)) {
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
  foreach ($r in $results) {
    $w = $r.webview
    $md += "## Scenario $($r.scenario), run $($r.run)", '', '| process | CPU avg % | CPU p95 % | private MB start / max / end |', '|---|---|---|---|'
    foreach ($p in $r.proc) { $md += "| $($p.group) | $($p.cpuAvg) | $($p.cpuP95) | $($p.memStartMB) / $($p.memMaxMB) / $($p.memEndMB) |" }
    if ($w) {
      $md += '', "- flood: $($w.floodSeconds) s (wall $([math]::Round($w.wallSeconds)) s, window hidden $($w.hiddenMs) ms, longest output gap $($w.maxOutputGapMs) ms)",
        "- echo latency ms: p50 $($w.echo.p50), p95 $($w.echo.p95), max $($w.echo.max) ($($w.echo.samples) samples, $($w.echo.unanswered) unanswered)",
        "- long tasks: $($w.longTasks.count) (over 50 ms: $($w.longTasks.over50), total $($w.longTasks.totalMs) ms, max $($w.longTasks.max) ms)",
        "- frame ms: p50 $($w.frames.p50), p95 $($w.frames.p95), p99 $($w.frames.p99), max $($w.frames.max) (over 50 ms: $($w.frames.over50) of $($w.frames.count))"
      foreach ($st in $w.streams) { $md += "- line integrity: seen $($st.seen) lines, missing $($st.missingLines), gaps $($st.gaps), dupes $($st.dupes), unparsed chars $($st.charsUnparsed), hashOk $($st.hashOk)" }
    }
    $md += ''
  }
  $md -join "`n" | Set-Content (Join-Path $outDir 'summary.md')
  Write-Host ($md -join "`n")
  Write-Host "results in $outDir"
} finally {
  if (-not $KeepRunning) {
    # Stop only what this run started; the user's Swarmterm is in neither set.
    # The StartTime check guards against a recycled PID.
    $live = Get-Process -Id $npm.Id -ErrorAction SilentlyContinue
    if ($live -and $live.StartTime -eq $npmStart) { & taskkill.exe /PID $npm.Id /T /F | Out-Null }
    foreach ($id in (Get-DevHostPids $hostExe)) { if ($id -notin $foreignHosts) { & taskkill.exe /PID $id /T /F | Out-Null } }
  }
}

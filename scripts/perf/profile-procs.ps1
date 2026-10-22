<#
.SYNOPSIS
  1 Hz per-process CPU sampler for profile runs (docs/perf-profiling.md).

.DESCRIPTION
  Samples every msedgewebview2 process (typed by its --type= switch: browser,
  renderer, gpu-process, utility, ...), conhost/OpenConsole, swarmterm and
  swarmterm-host, writing one CSV row per process per second:
    epochMs,pid,name,type,cpuPct(of one core),privateMB
  Runs until -StopFile exists or -Seconds elapse. Unelevated; it only reads
  process counters. With -RootPid only descendants of that pid are sampled
  (the instance flood.ps1 started), so the user's own Swarmterm and Edge
  never show up.
#>
param(
  [Parameter(Mandatory)][string]$Csv,
  [int]$RootPid = 0,
  [string]$StopFile = '',
  [int]$Seconds = 3600,
  # The terminal host breaks away from the app's tree; match it by path.
  [string]$HostExe = ''
)
$ErrorActionPreference = 'Stop'
$names = '^(msedgewebview2|conhost|OpenConsole|swarmterm|swarmterm-host)$'

function Get-Tree([int]$root) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath
  if (-not $root) { return $all }
  $keep = @{ $root = $true }
  if ($HostExe) { foreach ($p in $all) { if ($p.ExecutablePath -and $p.ExecutablePath -ieq $HostExe) { $keep[[int]$p.ProcessId] = $true } } }
  # Parents always precede children after a few passes; 6 covers npm→cargo→app→webview.
  for ($i = 0; $i -lt 6; $i++) { foreach ($p in $all) { if ($keep[[int]$p.ParentProcessId]) { $keep[[int]$p.ProcessId] = $true } } }
  $all | Where-Object { $keep[[int]$_.ProcessId] }
}

'epochMs,pid,name,type,cpuPct,privateMB' | Set-Content $Csv
$prev = @{}
$end = (Get-Date).AddSeconds($Seconds)
$tree = @(); $treeAt = [datetime]::MinValue
while ((Get-Date) -lt $end -and -not ($StopFile -and (Test-Path $StopFile))) {
  # The tree changes slowly (panes spawn conhosts); refresh it every 5 s.
  if (((Get-Date) - $treeAt).TotalSeconds -ge 5) {
    $tree = @(Get-Tree $RootPid | Where-Object { ($_.Name -replace '\.exe$', '') -match $names })
    $treeAt = Get-Date
  }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $rows = foreach ($t in $tree) {
    $p = Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $cpu = $p.TotalProcessorTime.TotalMilliseconds
    $pct = ''
    if ($prev.ContainsKey($p.Id)) { $d = $prev[$p.Id]; $pct = [math]::Round(100 * ($cpu - $d.cpu) / [math]::Max(1, $now - $d.at), 1) }
    $prev[$p.Id] = @{ cpu = $cpu; at = $now }
    $type = if ($t.CommandLine -match '--type=([\w-]+)') { $Matches[1] } elseif ($p.ProcessName -eq 'msedgewebview2') { 'browser' } else { '' }
    [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0},{1},{2},{3},{4},{5:F1}', $now, $p.Id, $p.ProcessName, $type, $pct, $p.PrivateMemorySize64 / 1MB)
  }
  if ($rows) { $rows | Add-Content $Csv }
  Start-Sleep -Milliseconds 1000
}

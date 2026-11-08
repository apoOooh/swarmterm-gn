<#
.SYNOPSIS
  Side-by-side comparison of two perf runs from scripts/perf/flood.ps1.

.DESCRIPTION
  Reads summary.json of both run folders and prints, per scenario, every
  numeric metric (median over that scenario's ok runs) of -Base and -New with
  the delta and delta %: echo, frames, long tasks, lag, War Room, renderer
  counts, process CPU/memory and the timings (wall, setup, run, teardown,
  stream duration, first output, all output parsed). Failed or skipped runs
  are listed with their reason, never folded into the numbers. Metrics a
  build could not measure show "unsupported". Process rows include the
  WebView2 process types (wv-*) and console hosts; scenario i is idle CPU.

.EXAMPLE
  pwsh scripts/perf/compare.ps1 -Base test-results/perf-runs/20261020-121206 -New test-results/perf-runs/20261020-150000
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$Base,
  [Parameter(Mandatory)] [string]$New,
  # Hide rows whose value is identical in both runs.
  [switch]$ChangedOnly
)
$ErrorActionPreference = 'Stop'

function Read-Run([string]$dir) {
  $f = Join-Path $dir 'summary.json'
  if (-not (Test-Path $f)) { throw "no summary.json in $dir" }
  @(Get-Content $f -Raw | ConvertFrom-Json)
}

# Bulky or non-metric parts of a result: per-sample arrays, per-pane detail,
# capability flags, epoch window.
$skip = 'samples', 'perPane', 'streams', 'caps', 'host', 'notes', 'windowStartMs', 'windowEndMs', 'scenario', 'flood', 'idle', 'hostMode', 'error', 'failed'

function Add-Leaves($obj, [string]$prefix, [hashtable]$into) {
  if ($null -eq $obj) { return }
  foreach ($p in $obj.PSObject.Properties) {
    if ($p.Name -in $skip) { continue }
    $k = if ($prefix) { "$prefix.$($p.Name)" } else { $p.Name }
    $v = $p.Value
    if ($v -is [pscustomobject]) { Add-Leaves $v $k $into }
    elseif ($v -is [string] -and $v -eq 'unsupported') { $into[$k] = 'unsupported' }
    elseif ($v -is [ValueType] -and $v -isnot [bool]) { $into[$k] = [double]$v }
  }
}

# scenario -> metric -> list of values over ok runs; plus failures.
function Get-Metrics($runs) {
  $m = @{}; $bad = @()
  foreach ($r in $runs) {
    if ($r.status -and $r.status -ne 'ok') { $bad += "$($r.scenario) run $($r.run): $($r.status) - $($r.reason)"; continue }
    if (-not $r.webview) { $bad += "$($r.scenario) run $($r.run): no result"; continue }
    $leaves = @{}
    Add-Leaves $r.webview '' $leaves
    foreach ($p in @($r.proc)) { foreach ($f in 'cpuAvg', 'cpuP95', 'memStartMB', 'memMaxMB', 'memEndMB') { if ($null -ne $p.$f) { $leaves["proc.$($p.group).$f"] = [double]$p.$f } } }
    if ($null -ne $r.wallSeconds) { $leaves['timing.wallSeconds'] = [double]$r.wallSeconds }
    if (-not $m.ContainsKey($r.scenario)) { $m[$r.scenario] = @{} }
    foreach ($k in $leaves.Keys) {
      if (-not $m[$r.scenario].ContainsKey($k)) { $m[$r.scenario][$k] = [Collections.Generic.List[object]]::new() }
      $m[$r.scenario][$k].Add($leaves[$k])
    }
  }
  @{ metrics = $m; bad = $bad }
}

function Get-Median($vals) {
  if ($null -eq $vals -or $vals.Count -eq 0) { return $null }
  if ($vals | Where-Object { $_ -is [string] }) { return 'unsupported' }
  $o = @($vals | Sort-Object)
  if ($o.Count % 2) { $o[[int][math]::Floor($o.Count / 2)] } else { ($o[$o.Count / 2 - 1] + $o[$o.Count / 2]) / 2 }
}

$b = Get-Metrics (Read-Run $Base)
$n = Get-Metrics (Read-Run $New)
"Base: $Base"
"New:  $New"
foreach ($x in @(@{ name = 'Base'; r = $b }, @{ name = 'New'; r = $n })) {
  foreach ($line in $x.r.bad) { "!! $($x.name) FAILED/SKIPPED: $line" }
}
$fmt = { param($v) if ($null -eq $v) { 'n/a' } elseif ($v -is [string]) { $v } else { [math]::Round([double]$v, 3).ToString([Globalization.CultureInfo]::InvariantCulture) } }
$scen = @($b.metrics.Keys + $n.metrics.Keys | Sort-Object -Unique)
foreach ($s in $scen) {
  $bm = if ($b.metrics.ContainsKey($s)) { $b.metrics[$s] } else { @{} }
  $nm = if ($n.metrics.ContainsKey($s)) { $n.metrics[$s] } else { @{} }
  $rows = foreach ($k in @($bm.Keys + $nm.Keys | Sort-Object -Unique)) {
    $bv = Get-Median $bm[$k]; $nv = Get-Median $nm[$k]
    $num = $bv -is [double] -and $nv -is [double]
    if ($ChangedOnly -and $num -and $bv -eq $nv) { continue }
    [pscustomobject]@{
      metric = $k; base = & $fmt $bv; new = & $fmt $nv
      delta = if ($num) { & $fmt ($nv - $bv) } else { '' }
      'delta %' = if ($num -and $bv -ne 0) { (& $fmt (100 * ($nv - $bv) / [math]::Abs($bv))) + '%' } else { '' }
    }
  }
  ''
  "== scenario $s =="
  $rows | Format-Table -AutoSize | Out-String -Width 200 | ForEach-Object { $_.TrimEnd() }
}

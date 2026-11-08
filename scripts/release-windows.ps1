# Build a Windows release of Swarmterm: the NSIS installer. No Authenticode —
# SmartScreen's "Unknown publisher" flow is accepted and documented in
# docs/release-windows.md.
#
#   npm run release:win
#
# Credentials come from .env.release (gitignored), same format as macOS.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Die($msg) {
  Write-Host "release-windows: $msg" -ForegroundColor Red
  exit 1
}

if (Test-Path ".env.release") {
  Get-Content ".env.release" | ForEach-Object {
    if ($_ -match '^\s*(#|$)') { return }
    $name, $value = $_ -split '=', 2
    if ($null -eq $value) { return }
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim().Trim('"'), "Process")
  }
}

$config = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$version = $config.version
Write-Host "==> building NSIS installer (v$version)"
# npx, not `npm run tauri -- …`: PowerShell swallows a bare `--`, npm then
# eats `--bundles` as its own flag, and cargo receives a stray `nsis`.
npx tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) { Die "tauri build failed" }

$setup = "src-tauri/target/release/bundle/nsis/$($config.productName)_${version}_x64-setup.exe"
if (-not (Test-Path $setup)) { Die "installer not found: $setup" }

Write-Host "==> release OK: $setup"

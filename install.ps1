#!/usr/bin/env pwsh
#
# Bootstrap installer for Windows. Clones Jun OS (if not already present),
# prepares .env, and launches it via start.ps1 — which autodetects your GPU.
#
#   irm https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.ps1 | iex
#
# Overrides (set before running): $env:JUN_REPO, $env:JUN_DIR, $env:JUN_REF.
# Prefer to read before you run? Sensible — open the file first, then clone
# the repo and run ./start.ps1 yourself.

$ErrorActionPreference = 'Stop'

$repo = if ($env:JUN_REPO) { $env:JUN_REPO } else { 'https://github.com/efficiencyx/JunOS.git' }
$dir  = if ($env:JUN_DIR)  { $env:JUN_DIR }  else { 'JunOS' }
$ref  = if ($env:JUN_REF)  { $env:JUN_REF }  else { 'main' }

foreach ($cmd in @('git', 'docker')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "'$cmd' is required but not installed."
    }
}

if (Test-Path (Join-Path $dir '.git')) {
    Write-Host "==> $dir already cloned, pulling latest"
    git -C $dir pull --ff-only
} else {
    Write-Host "==> Cloning $repo ($ref) into $dir"
    git clone --depth 1 --branch $ref $repo $dir
}

Set-Location -LiteralPath $dir
if (-not (Test-Path .env)) { Copy-Item .env.example .env }

Write-Host "==> Starting"
# Re-launch via the same PowerShell with Bypass so the machine's execution
# policy can't block start.ps1 (this script may have arrived through `iex`).
$psExe = (Get-Process -Id $PID).MainModule.FileName
& $psExe -NoProfile -ExecutionPolicy Bypass -File (Resolve-Path './start.ps1').Path
exit $LASTEXITCODE

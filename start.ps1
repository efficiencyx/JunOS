#!/usr/bin/env pwsh
#
# One-command launcher for Windows (mirror of start.sh). Detects the GPU and
# layers the matching compose overlay on top of the CPU-only base.
#
#   ./start.ps1                       # auto-detect
#   ./start.ps1 -Gpu cpu              # force a backend: nvidia | amd | cpu
#   $env:VOICE='off'; ./start.ps1     # skip the Kokoro TTS sidecar (default: on, from .env)
#   ./start.ps1 up -d --no-build      # extra args are forwarded to compose
#
# Production + TLS:
#   $env:COMPOSE_PROFILES='prod'; $env:TLS_MODE='on'
#   $env:DOMAIN='example.com'; $env:EMAIL='you@example.com'; ./start.ps1
#
# Note: Docker Desktop runs containers in WSL2. NVIDIA works there via the
# NVIDIA WSL driver; AMD ROCm in Docker is a Linux-only path, so on Windows
# this falls back to CPU unless you explicitly force -Gpu amd.

[CmdletBinding()]
param(
    [ValidateSet('auto', 'nvidia', 'amd', 'cpu')]
    [string]$Gpu = 'auto',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ComposeArgs
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Get-GpuKind {
    if ($Gpu -ne 'auto') { return $Gpu }

    $nvidia = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvidia) {
        & nvidia-smi -L *> $null
        if ($LASTEXITCODE -eq 0) { return 'nvidia' }
    }
    return 'cpu'
}

# Voice (TTS) is a compose profile. $env:VOICE wins; else read what install.ps1
# wrote to .env; default on.
$voice = $env:VOICE
if (-not $voice -and (Test-Path .env)) {
    $line = Select-String -Path .env -Pattern '^VOICE=' | Select-Object -Last 1
    if ($line) { $voice = ($line.Line -replace '^VOICE=', '').Trim() }
}
if (-not $voice) { $voice = 'on' }

$kind = Get-GpuKind
$files = @('-f', 'docker-compose.yml')
$profiles = @()
if ($voice -eq 'on') { $profiles += @('--profile', 'voice') }

switch ($kind) {
    'nvidia' {
        $files += @('-f', 'docker-compose.nvidia.yml')
    }
    'amd' {
        Write-Warning 'AMD ROCm in Docker is a Linux path (needs /dev/kfd). On Windows this usually falls back to CPU — proceeding anyway.'
        # Placeholder GIDs so the overlay interpolates; the device mounts decide if it actually runs.
        if (-not $env:VIDEO_GID)  { $env:VIDEO_GID = '44' }
        if (-not $env:RENDER_GID) { $env:RENDER_GID = '105' }
        $files += @('-f', 'docker-compose.amd.yml')
    }
}

Write-Host "GPU detected: $kind"
Write-Host "Voice (TTS): $voice"

$argv = $files + $profiles + @('up', '-d', '--build') + $ComposeArgs
& docker compose @argv
exit $LASTEXITCODE

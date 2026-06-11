#!/usr/bin/env pwsh
#
# Bootstrap installer for Windows. Clones Jun OS (if not already present),
# prepares .env, and launches it via start.ps1 — which autodetects your GPU.
#
#   irm https://raw.githubusercontent.com/efficiencyx/Jun/main/install.ps1 | iex
#
# On a fresh machine it checks for git + Docker and offers to install them
# with winget. In a terminal it then asks which model to pull (auto-detecting a
# default from your VRAM) and whether to enable voice; piped or with
# $env:JUN_YES='1' it stays one-command (12B model + voice on). Override
# non-interactively: $env:JUN_MODEL='12b|e4b|e2b|<full-ref>', $env:VOICE='on|off'.
#
# Overrides: $env:JUN_REPO, $env:JUN_DIR, $env:JUN_REF.
# Set $env:JUN_YES='1' to skip prompts (assume yes).
# Prefer to read before you run? Sensible — open the file first, then clone
# the repo and run ./start.ps1 yourself.

$ErrorActionPreference = 'Stop'

$repo = if ($env:JUN_REPO) { $env:JUN_REPO } else { 'https://github.com/efficiencyx/Jun.git' }
$dir  = if ($env:JUN_DIR)  { $env:JUN_DIR }  else { 'Jun' }
$ref  = if ($env:JUN_REF)  { $env:JUN_REF }  else { 'main' }

# winget package ids for the things we depend on.
$wingetIds = @{ git = 'Git.Git'; docker = 'Docker.DockerDesktop' }
$manualUrls = @{
    git    = 'https://git-scm.com/download/win'
    docker = 'https://www.docker.com/products/docker-desktop/'
}

# Short aliases the menu and $env:JUN_MODEL accept; anything else is verbatim.
$models = @{
    '12b' = 'hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL'   # best, >8GB VRAM
    'e4b' = 'hf.co/unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL'   # fast, ~6GB VRAM
    'e2b' = 'hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL'   # fastest, CPU-ok
}

function Resolve-Model([string]$a) {
    switch -Regex ($a.ToLower()) {
        '^(12b|best)$'         { return $models['12b'] }
        '^(e4b|balanced|fast)$' { return $models['e4b'] }
        '^(e2b|fastest|cpu)$'  { return $models['e2b'] }
        default                { return $a }
    }
}

# Best-effort total VRAM in MB ($null when no NVIDIA GPU / no tool to ask).
function Get-VramMb {
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $out = & nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
        if ($out) { return [int](($out -split "`n")[0].Trim()) }
    }
    return $null
}

function Recommend-Alias([int]$mb) {
    if ($mb -ge 8500) { return '12b' }
    if ($mb -ge 6000) { return 'e4b' }
    return 'e2b'
}

function Set-EnvKey([string]$key, [string]$val) {
    $lines = @()
    if (Test-Path .env) { $lines = Get-Content .env | Where-Object { $_ -notmatch "^$key=" } }
    $lines += "$key=$val"
    Set-Content -Path .env -Value $lines
}

# Ask which model + whether voice, then persist both into .env. Non-interactive
# (JUN_YES, per-field env override, or no console) keeps the one-command flow.
function Configure-Jun {
    $vram = Get-VramMb
    $rec  = if ($null -ne $vram) { Recommend-Alias $vram } else { 'e2b' }

    $alias = $env:JUN_MODEL
    $interactive = [Environment]::UserInteractive -and ($env:JUN_YES -ne '1')
    if (-not $alias) {
        if ($interactive) {
            $recName = @{ '12b' = 'gemma 12B'; 'e4b' = 'gemma E4B'; 'e2b' = 'gemma E2B' }[$rec]
            Write-Host ""
            Write-Host "Which model should Jun run?"
            Write-Host "  1) gemma 12B  - best quality, needs >8GB VRAM"
            Write-Host "  2) gemma E4B  - fast, decent quality, ~6GB VRAM"
            Write-Host "  3) gemma E2B  - fastest, lower quality, runs on CPU"
            if ($null -ne $vram) { Write-Host "  (detected ${vram}MB VRAM)" }
            $ans = Read-Host "Choice [Enter = $recName]"
            switch ($ans) {
                '1' { $alias = '12b' }
                '2' { $alias = 'e4b' }
                '3' { $alias = 'e2b' }
                ''  { $alias = $rec }
                default { Write-Host "Unrecognized choice, using $recName."; $alias = $rec }
            }
        } else {
            $alias = '12b'   # one-command default: gemma 12B
        }
    }

    $voice = $env:VOICE
    if ($voice) {
        $voice = if ($voice.ToLower() -match '^(off|0|false|no)$') { 'off' } else { 'on' }
    } elseif ($interactive) {
        $v = Read-Host "Enable voice (TTS)? [Y/n]"
        $voice = if ($v -match '^(n|no)$') { 'off' } else { 'on' }
    } else {
        $voice = 'on'
    }

    $ref = Resolve-Model $alias
    Set-EnvKey 'OLLAMA_MODELS_TO_PULL' "$ref,nomic-embed-text"
    Set-EnvKey 'VOICE' $voice
    Write-Host "==> Config: model=$ref, voice=$voice"
}

function Confirm-Deps {
    $missing = @()
    foreach ($c in 'git', 'docker') {
        if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { $missing += $c }
    }
    if ($missing.Count -eq 0) { return }

    Write-Host ""
    Write-Warning ("These required tools aren't installed: {0}" -f ($missing -join ', '))

    # Without winget we can't install for them — point at the downloads and stop.
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "winget (App Installer) isn't available, so install them manually and re-run:"
        foreach ($c in $missing) { Write-Host ("  {0,-7} {1}" -f $c, $manualUrls[$c]) }
        exit 1
    }

    $proceed = $env:JUN_YES -eq '1'
    if (-not $proceed) {
        if (-not [Environment]::UserInteractive) {
            Write-Host "Re-run in an interactive terminal (or set `$env:JUN_YES='1') to install them."
            exit 1
        }
        $answer = Read-Host ("Install {0} now with winget? [y/N]" -f ($missing -join ' and '))
        $proceed = $answer -match '^(y|yes)$'
    }
    if (-not $proceed) {
        Write-Host "Okay, leaving it to you. Install the tools above and re-run this installer."
        exit 1
    }

    foreach ($c in $missing) {
        Write-Host ("==> Installing {0} via winget" -f $wingetIds[$c])
        winget install -e --id $wingetIds[$c] --accept-source-agreements --accept-package-agreements
    }

    # winget can't refresh this session's PATH or start the Docker daemon. A
    # fresh process picks up the new PATH, so launch Docker Desktop and hand off
    # to a new window that waits for the daemon and re-runs the one-liner.
    if ($missing -contains 'docker') {
        $dd = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (Test-Path $dd) {
            Write-Host "==> Launching Docker Desktop"
            Start-Process $dd | Out-Null
        }
    }

    $installUrl = if ($env:JUN_INSTALL_URL) { $env:JUN_INSTALL_URL } `
        else { "https://raw.githubusercontent.com/efficiencyx/Jun/$ref/install.ps1" }

    $boot = @"
Write-Host 'Waiting for Docker to be ready...'
for (`$i = 0; `$i -lt 60; `$i++) {
    & docker info *> `$null
    if (`$LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 3
}
if (`$LASTEXITCODE -ne 0) {
    Write-Warning 'Docker still not ready. If setup asked for a reboot, restart Windows and run the one-liner again.'
}
irm $installUrl | iex
"@
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($boot))
    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc) | Out-Null

    Write-Host ""
    Write-Host "Installed. A new window will open, wait for Docker, and finish the setup here."
    if ($missing -contains 'docker') {
        Write-Host "If Docker Desktop asks for a reboot, restart Windows and re-run the one-liner."
    }
    exit 0
}

Confirm-Deps

if (Test-Path (Join-Path $dir '.git')) {
    Write-Host "==> $dir already cloned, pulling latest"
    git -C $dir pull --ff-only
} else {
    Write-Host "==> Cloning $repo ($ref) into $dir"
    git clone --depth 1 --branch $ref $repo $dir
}

Set-Location -LiteralPath $dir
if (-not (Test-Path .env)) { Copy-Item .env.example .env }

Configure-Jun

Write-Host "==> Starting"
# Re-launch via the same PowerShell with Bypass so the machine's execution
# policy can't block start.ps1 (this script may have arrived through `iex`).
$psExe = (Get-Process -Id $PID).MainModule.FileName
& $psExe -NoProfile -ExecutionPolicy Bypass -File (Resolve-Path './start.ps1').Path
exit $LASTEXITCODE

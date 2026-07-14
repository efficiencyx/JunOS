#!/usr/bin/env pwsh
#
# Bare-metal launcher for Windows (Linux/macOS keep the Docker path via
# start.sh). No containers: Ollama runs natively, the webapp is served by
# PHP's built-in server, and the optional TTS sidecar runs from a Python
# venv. Everything this script creates lives under .\runtime so
# uninstall.ps1 can remove it cleanly.
#
#   ./start.ps1              # start everything (default)
#   ./start.ps1 stop         # stop the processes started here
#   ./start.ps1 status       # show what's running
#
# Config comes from .env (copied from .env.example by install.ps1):
#   JUN_PORT               web UI port           (default 8080)
#   AI_PROVIDER            ollama|openrouter|llamacpp (default ollama)
#   OLLAMA_MODELS_TO_PULL  models pulled on boot (ollama / local embeddings)
#   OPENROUTER_API_KEY/OPENROUTER_MODEL   openrouter settings
#   LLAMACPP_MODEL_HF/LLAMACPP_PORT       managed llama-server (default port 8081)
#   LLAMACPP_URL           existing llama-server to use instead of launching one
#   EMBEDDINGS             on|off  local Ollama RAG embeddings
#   VOICE                  on|off  TTS sidecar
#   TTS_DEVICE             cpu|cuda|auto

[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$Runtime  = Join-Path $PSScriptRoot 'runtime'
$LogDir   = Join-Path $Runtime 'logs'
$PidFile  = Join-Path $Runtime 'pids.json'
$StateDir = Join-Path $Runtime 'state'

# ── .env ─────────────────────────────────────────────────────────────────────
# Load KEY=VALUE pairs as process env vars unless already set (so the shell
# can still override per-run).
if (Test-Path .env) {
    foreach ($line in Get-Content .env) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $k = $Matches[1]; $v = $Matches[2].Trim()
            # Docker-internal hostnames from .env.example don't resolve on bare
            # metal; ignore them and use our localhost defaults instead.
            if ($v -match '://(ollama|kokoro|nginx|php|llamacpp)\b') { continue }
            if (-not (Get-Item "env:$k" -ErrorAction SilentlyContinue)) {
                Set-Item "env:$k" $v
            }
        }
    }
}

$Port      = if ($env:JUN_PORT) { $env:JUN_PORT } else { '8080' }
$OllamaUrl = if ($env:OLLAMA_URL) { $env:OLLAMA_URL } else { 'http://127.0.0.1:11434' }
$SiteUrl   = "http://127.0.0.1:$Port"

$Provider  = if ($env:AI_PROVIDER) { $env:AI_PROVIDER.ToLower() } else { 'ollama' }
if ($Provider -notin 'ollama', 'openrouter', 'llamacpp') { $Provider = 'ollama' }
# Embeddings default on only for the ollama provider; they always run on Ollama.
$EmbedOn = if ($env:EMBEDDINGS) { $env:EMBEDDINGS.ToLower() -eq 'on' } else { $Provider -eq 'ollama' }
$LlamaPort = if ($env:LLAMACPP_PORT) { $env:LLAMACPP_PORT } else { '8081' }
$LlamacppUrl = if ($env:LLAMACPP_URL) { $env:LLAMACPP_URL } else { "http://127.0.0.1:$LlamaPort" }

function Read-Pids {
    if (Test-Path $PidFile) {
        try { return Get-Content $PidFile -Raw | ConvertFrom-Json } catch {}
    }
    return $null
}

function Get-TrackedProcess([object]$pids, [string]$name) {
    if (-not $pids -or -not $pids.$name) { return $null }
    $p = Get-Process -Id $pids.$name -ErrorAction SilentlyContinue
    if ($p) { return $p }
    return $null
}

function Test-Http([string]$url, [int]$timeoutSec = 2) {
    try {
        Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec | Out-Null
        return $true
    } catch { return $false }
}

# ── stop / status ────────────────────────────────────────────────────────────
if ($Action -eq 'stop') {
    $pids = Read-Pids
    foreach ($name in 'php', 'tts', 'ollama', 'llamacpp') {
        $p = Get-TrackedProcess $pids $name
        if ($p) {
            Write-Host "==> Stopping $name (pid $($p.Id))"
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host 'Stopped.'
    exit 0
}

if ($Action -eq 'status') {
    $pids = Read-Pids
    foreach ($name in 'php', 'tts', 'ollama', 'llamacpp') {
        $p = Get-TrackedProcess $pids $name
        $state = if ($p) { "running (pid $($p.Id))" } else { 'not running' }
        Write-Host ("  {0,-7} {1}" -f $name, $state)
    }
    Write-Host ("  web UI  {0}" -f $(if (Test-Http $SiteUrl) { $SiteUrl } else { 'not responding' }))
    exit 0
}

# ── start ────────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $Runtime, $LogDir, $StateDir, (Join-Path $StateDir 'rl') | Out-Null
$newPids = @{}
$oldPids = Read-Pids

function Start-Tracked([string]$name, [string]$exe, [string[]]$exeArgs) {
    $out = Join-Path $LogDir "$name.log"
    $err = Join-Path $LogDir "$name.err.log"
    $p = Start-Process -FilePath $exe -ArgumentList $exeArgs -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    $script:newPids[$name] = $p.Id
    return $p
}

# ── ollama ───────────────────────────────────────────────────────────────────
# Needed when it's the chat provider, or for local embeddings alongside a
# non-Ollama provider. If an Ollama server is already up (the desktop app
# autostarts one), use it. Otherwise launch `ollama serve` ourselves, with the
# model store inside the install folder so weights disappear with it on
# uninstall.
if ($Provider -eq 'ollama' -or $EmbedOn) {
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    throw 'ollama is not installed. Run install.ps1 first (it installs Ollama via winget).'
}

$ownOllama = $false
if (-not (Test-Http "$OllamaUrl/api/tags")) {
    Write-Host '==> Starting ollama serve'
    $env:OLLAMA_HOST   = '127.0.0.1:11434'
    $env:OLLAMA_MODELS = Join-Path $Runtime 'ollama-models'
    # Memory caps, same rationale as the Docker setup: one slot, two models,
    # 8-bit KV cache (needs flash attention; falls back to f16 elsewhere).
    if (-not $env:OLLAMA_NUM_PARALLEL)      { $env:OLLAMA_NUM_PARALLEL = '1' }
    if (-not $env:OLLAMA_MAX_LOADED_MODELS) { $env:OLLAMA_MAX_LOADED_MODELS = '2' }
    if (-not $env:OLLAMA_KEEP_ALIVE)        { $env:OLLAMA_KEEP_ALIVE = '5m' }
    if (-not $env:OLLAMA_FLASH_ATTENTION)   { $env:OLLAMA_FLASH_ATTENTION = '1' }
    if (-not $env:OLLAMA_KV_CACHE_TYPE)     { $env:OLLAMA_KV_CACHE_TYPE = 'q8_0' }
    Start-Tracked 'ollama' 'ollama' @('serve') | Out-Null
    $ownOllama = $true

    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Http "$OllamaUrl/api/tags")) {
        if ((Get-Date) -gt $deadline) { throw "ollama did not come up on $OllamaUrl (see runtime\logs\ollama.err.log)" }
        Start-Sleep -Seconds 1
    }
} else {
    Write-Host "==> Using already-running Ollama at $OllamaUrl (its models live in its own store, usually ~\.ollama)"
    $p = Get-TrackedProcess $oldPids 'ollama'
    if ($p) { $newPids['ollama'] = $p.Id }
}

# Pull models (idempotent - cached weights aren't re-downloaded).
$chatModel = ''
if ($env:OLLAMA_MODELS_TO_PULL) {
    foreach ($raw in $env:OLLAMA_MODELS_TO_PULL -split ',') {
        $m = $raw.Trim()
        if (-not $m) { continue }
        Write-Host "==> Pulling $m"
        & ollama pull $m
        if ($LASTEXITCODE -ne 0 -and $m -match '^hf\.co/') {
            # Older Ollama builds reject the hf.co alias ("realm host
            # huggingface.co does not match original host hf.co").
            $m = $m -replace '^hf\.co/', 'huggingface.co/'
            Write-Host "==> Retrying as $m"
            & ollama pull $m
        }
        if ($LASTEXITCODE -ne 0) { Write-Warning "pull failed: $m (continuing)" }
        if (-not $chatModel -and $m -ne 'nomic-embed-text') { $chatModel = $m }
    }
}

# Pre-warm: an empty-prompt generate makes ollama load the chat model now, so
# the first real message doesn't pay the cold-load cost. Fire and forget - the
# short timeout aborts our wait, not the server-side load.
if ($chatModel -and $Provider -eq 'ollama') {
    Write-Host "==> Pre-warming $chatModel (loads in the background)"
    try {
        Invoke-RestMethod -Method Post -Uri "$OllamaUrl/api/generate" -ContentType 'application/json' `
            -Body (@{ model = $chatModel; prompt = ''; stream = $false } | ConvertTo-Json) -TimeoutSec 5 | Out-Null
    } catch {}
}
}

# ── llama.cpp (managed llama-server) ─────────────────────────────────────────
# Only when AI_PROVIDER=llamacpp and LLAMACPP_URL targets this machine; a
# remote/custom URL means the user runs their own server. Weights cache under
# runtime\llama-cache so they disappear with the folder on uninstall.
if ($Provider -eq 'llamacpp' -and $LlamacppUrl -match '://(127\.0\.0\.1|localhost)\b') {
    if (Test-Http "$LlamacppUrl/health") {
        Write-Host "==> Using already-running llama-server at $LlamacppUrl"
        $p = Get-TrackedProcess $oldPids 'llamacpp'
        if ($p) { $newPids['llamacpp'] = $p.Id }
    } else {
        if (-not (Get-Command llama-server -ErrorAction SilentlyContinue)) {
            throw 'llama-server is not installed. Run install.ps1 first (it installs llama.cpp via winget).'
        }
        $hfRef = if ($env:LLAMACPP_MODEL_HF) { $env:LLAMACPP_MODEL_HF } else { 'efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q4_K_M' }
        Write-Host "==> Starting llama-server ($hfRef; first run downloads the model)"
        $env:LLAMA_CACHE = Join-Path $Runtime 'llama-cache'
        $llamaProc = Start-Tracked 'llamacpp' 'llama-server' @(
            '-hf', $hfRef, '--host', '127.0.0.1', '--port', $LlamaPort, '-c', '16384', '--jinja')

        # Generous deadline: the first boot downloads the GGUF before /health
        # goes green. A dead process fails fast instead of waiting it out.
        $deadline = (Get-Date).AddMinutes(15)
        while (-not (Test-Http "$LlamacppUrl/health")) {
            if ($llamaProc.HasExited) { throw "llama-server exited (code $($llamaProc.ExitCode)) - see runtime\logs\llamacpp.err.log" }
            if ((Get-Date) -gt $deadline) { throw "llama-server did not come up on $LlamacppUrl (see runtime\logs\llamacpp.err.log)" }
            Start-Sleep -Seconds 2
        }
    }
}

# ── TTS sidecar (optional) ───────────────────────────────────────────────────
$ttsPython = Join-Path $Runtime 'tts-venv\Scripts\python.exe'
$voiceOff = $env:VOICE -and $env:VOICE.ToLower() -match '^(off|0|false|no)$'
if (-not $voiceOff -and (Test-Path $ttsPython)) {
    $p = Get-TrackedProcess $oldPids 'tts'
    if ($p) {
        $newPids['tts'] = $p.Id
        Write-Host '==> TTS already running'
    } else {
        Write-Host '==> Starting TTS sidecar (first run downloads voice models)'
        $env:TTS_HOST    = '127.0.0.1'
        $env:TTS_PORT    = '8001'
        $env:CORS_ORIGIN = $SiteUrl
        $env:HF_HOME     = Join-Path $Runtime 'hf-cache'
        Start-Tracked 'tts' $ttsPython @((Join-Path $PSScriptRoot 'tts\server.py')) | Out-Null
    }
} elseif (-not $voiceOff) {
    Write-Host '==> Voice is on but the TTS venv is missing - re-run install.ps1 to set it up. Continuing text-only.'
}

# ── web server (PHP built-in) ────────────────────────────────────────────────
$phpExe = Join-Path $Runtime 'php\php.exe'
if (-not (Test-Path $phpExe)) {
    $cmd = Get-Command php -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'PHP not found. Run install.ps1 first (it puts a portable PHP under runtime\php).' }
    $phpExe = $cmd.Source
}

$old = Get-TrackedProcess $oldPids 'php'
if ($old) { Stop-Process -Id $old.Id -Force -ErrorAction SilentlyContinue }

# Sanity-check php.exe before launching it hidden: a missing VC++ runtime
# kills it with no visible error (NTSTATUS 0xC0000135 = missing DLL).
# Run through cmd so PHP warnings on stderr can't trip ErrorActionPreference.
cmd /c "`"$phpExe`" -v >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    if ($LASTEXITCODE -eq -1073741515) {
        throw "php.exe can't start: the Microsoft Visual C++ runtime is missing. Install the 'Microsoft Visual C++ 2015-2022 Redistributable (x64)' (winget install Microsoft.VCRedist.2015+.x64) and re-run."
    }
    throw "php.exe failed its self-check (exit code $LASTEXITCODE). Try re-running install.ps1."
}

Write-Host "==> Starting web server on $SiteUrl"
$env:AI_PROVIDER            = $Provider
$env:OLLAMA_URL             = $OllamaUrl
$env:LLAMACPP_URL           = $LlamacppUrl
$env:EMBEDDINGS             = if ($EmbedOn) { 'on' } else { 'off' }
# OPENROUTER_API_KEY / OPENROUTER_MODEL are already process env via the .env loader.
$env:KOKORO_URL             = 'http://127.0.0.1:8001'
$env:OMEGA_STATE_DIR        = $StateDir
# PHP honors this on Unix only; on Windows the built-in server stays
# single-worker, so requests made while a chat reply is streaming (e.g. TTS)
# queue until it finishes. Acceptable for a single local user.
$env:PHP_CLI_SERVER_WORKERS = '8'
$phpProc = Start-Tracked 'php' $phpExe @('-S', "127.0.0.1:$Port", '-t', (Join-Path $PSScriptRoot 'webapp'))

$newPids | ConvertTo-Json | Set-Content $PidFile

$deadline = (Get-Date).AddSeconds(20)
while (-not (Test-Http $SiteUrl)) {
    if ($phpProc.HasExited -or (Get-Date) -gt $deadline) {
        $err = Join-Path $LogDir 'php.err.log'
        if (Test-Path $err) {
            Write-Host '--- last lines of runtime\logs\php.err.log ---'
            Get-Content $err -Tail 10 | Write-Host
        }
        $why = if ($phpProc.HasExited) { "php exited (code $($phpProc.ExitCode))" } else { 'timed out' }
        throw "web server did not come up on ${SiteUrl}: $why"
    }
    Start-Sleep -Seconds 1
}

Write-Host ''
Write-Host "Jun is up: $SiteUrl"
Write-Host "Stop with: ./start.ps1 stop   |   Logs: runtime\logs\"
if (-not $NoBrowser) { Start-Process $SiteUrl }
exit 0

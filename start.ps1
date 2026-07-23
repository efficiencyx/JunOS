#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# Ensure Unicode glyphs render correctly on all console hosts.
try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $OutputEncoding = [Text.Encoding]::UTF8
} catch {}

# ── ANSI / VT escape setup ───────────────────────────────────────────────────
$VTSupported = $false
if ($Host.UI.SupportsVirtualTerminal -or $env:WT_SESSION -or
    $env:TERM_PROGRAM -eq 'vscode' -or $PSVersionTable.PSVersion.Major -ge 7) {
    $VTSupported = $true
}

if ($VTSupported) {
    $e      = [char]27
    $R      = "$e[0m"
    $B      = "$e[1m"
    $D      = "$e[2m"
    $ACCENT = "$e[38;2;96;205;255m"    # #60CDFF  Fluent light blue
    $BLUE   = "$e[38;2;0;120;212m"     # #0078D4  Windows system blue
    $OK     = "$e[38;2;108;203;95m"    # #6CCB5F  Fluent green
    $DANGER = "$e[38;2;255;76;76m"     # #FF4C4C  Fluent red
    $WARN   = "$e[38;2;252;225;0m"     # #FCE100  Fluent amber
    $DIM    = "$e[38;2;158;158;158m"   # #9E9E9E  Neutral gray
    $MUTED  = "$e[38;2;204;204;204m"   # #CCCCCC  Light gray
} else {
    $R = ''; $B = ''; $D = ''; $ACCENT = ''; $BLUE = ''; $OK = ''
    $DANGER = ''; $WARN = ''; $DIM = ''; $MUTED = ''
}

function Step([string]$msg)    { Write-Host "  ${ACCENT}▸${R} ${B}${msg}${R}" }
function Ok([string]$msg)      { Write-Host "    ${OK}✓${R} ${MUTED}${msg}${R}" }
function Note([string]$msg)    { Write-Host "    ${DIM}ℹ ${msg}${R}" }
function Warn_([string]$msg)   { Write-Host "    ${WARN}⚠${R} ${WARN}${msg}${R}" }
function Fail_([string]$msg)   { Write-Host "    ${DANGER}✗${R} ${DANGER}${msg}${R}" }
# ── end UI helpers ────────────────────────────────────────────────────────────

# UUIDs, not indices: nvidia-smi enumerates by PCI bus order while CUDA sorts
# by speed, so the same index means different cards to the two of them.
function Get-GpuOrder {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return $null }
    $rows = & nvidia-smi --query-gpu=memory.total,uuid --format=csv,noheader,nounits 2>$null
    $uuids = @($rows | Where-Object { $_ -match ',' } | ForEach-Object {
        $f = $_ -split ','
        [pscustomobject]@{ Mb = [int]($f[0].Trim()); Uuid = $f[1].Trim() }
    } | Sort-Object Mb -Descending | ForEach-Object { $_.Uuid })
    if ($uuids.Count -eq 0) { return $null }
    return ($uuids -join ',')
}

$Runtime  = Join-Path $PSScriptRoot 'runtime'
$LogDir   = Join-Path $Runtime 'logs'
$PidFile  = Join-Path $Runtime 'pids.json'
$StateDir = Join-Path $Runtime 'state'

# Load KEY=VALUE pairs as process env vars unless already set (so the shell
# can still override per-run).
if (Test-Path .env) {
    foreach ($line in Get-Content .env) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $k = $Matches[1]; $v = $Matches[2].Trim()
            # Docker-internal hostnames from .env.example don't resolve on bare
            # metal; ignore them and use our localhost defaults instead.
            if ($v -match '://(ollama|tts|kokoro|nginx|php|llamacpp)\b') { continue }
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
$LlamaPort = if ($env:LLAMACPP_PORT) { $env:LLAMACPP_PORT } else { '8081' }
$LlamacppUrl = if ($env:LLAMACPP_URL) { $env:LLAMACPP_URL } else { "http://127.0.0.1:$LlamaPort" }

$GpuDevices = if ($env:GPU_DEVICES) { $env:GPU_DEVICES.Trim() } else { '' }
if (-not $GpuDevices -or $GpuDevices -eq 'auto') {
    $GpuDevices = Get-GpuOrder
} elseif ($GpuDevices -eq 'all') {
    $GpuDevices = ''
}
# An empty CUDA_VISIBLE_DEVICES means zero GPUs, not all of them, so only set
# it when we actually have a list. The model servers inherit it.
if ($GpuDevices) { $env:CUDA_VISIBLE_DEVICES = $GpuDevices }
$TensorParallel = $env:TENSOR_PARALLEL -match '^(on|1|true|yes)$'

if ($Action -eq 'start') {
    if ($GpuDevices -and ($GpuDevices -split ',').Count -gt 1) {
        Note "GPU order (largest VRAM first): $GpuDevices"
    }
    if ($TensorParallel) { Note 'tensor parallel: one model split across all GPUs' }
}

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

if ($Action -eq 'stop') {
    Step 'stopping services'
    $pids = Read-Pids
    foreach ($name in 'php', 'memory', 'tts', 'ollama', 'llamacpp') {
        $p = Get-TrackedProcess $pids $name
        if ($p) {
            Ok "stopped $name (pid $($p.Id))"
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host ''
    Ok 'all services stopped'
    exit 0
}

if ($Action -eq 'status') {
    Step 'service status'
    $pids = Read-Pids
    foreach ($name in 'php', 'memory', 'tts', 'ollama', 'llamacpp') {
        $p = Get-TrackedProcess $pids $name
        if ($p) {
            Ok ("{0,-10} running (pid {1})" -f $name, $p.Id)
        } else {
            Note ("{0,-10} not running" -f $name)
        }
    }
    if (Test-Http $SiteUrl) {
        Ok "web UI     $SiteUrl"
    } else {
        Warn_ 'web UI     not responding'
    }
    exit 0
}

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

# If an Ollama server is already up (the desktop app autostarts one), use it.
# Otherwise launch `ollama serve` ourselves, with the model store inside the
# install folder so weights disappear with it on uninstall.
if ($Provider -eq 'ollama') {
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    throw 'ollama is not installed. Run install.ps1 first (it installs Ollama via winget).'
}

$ownOllama = $false
if (-not (Test-Http "$OllamaUrl/api/tags")) {
    Step 'start ollama serve'
    $env:OLLAMA_HOST   = '127.0.0.1:11434'
    $env:OLLAMA_MODELS = Join-Path $Runtime 'ollama-models'
    # Memory caps, same rationale as the Docker setup: one slot, two models,
    # 8-bit KV cache (needs flash attention; falls back to f16 elsewhere).
    if (-not $env:OLLAMA_NUM_PARALLEL)      { $env:OLLAMA_NUM_PARALLEL = '1' }
    if (-not $env:OLLAMA_MAX_LOADED_MODELS) { $env:OLLAMA_MAX_LOADED_MODELS = '2' }
    if (-not $env:OLLAMA_KEEP_ALIVE)        { $env:OLLAMA_KEEP_ALIVE = '5m' }
    if (-not $env:OLLAMA_FLASH_ATTENTION)   { $env:OLLAMA_FLASH_ATTENTION = '1' }
    if (-not $env:OLLAMA_KV_CACHE_TYPE)     { $env:OLLAMA_KV_CACHE_TYPE = 'q8_0' }
    # Ollama has no real tensor parallelism; spreading the layers is as close
    # as it gets.
    if ($TensorParallel -and -not $env:OLLAMA_SCHED_SPREAD) { $env:OLLAMA_SCHED_SPREAD = '1' }
    Start-Tracked 'ollama' 'ollama' @('serve') | Out-Null
    $ownOllama = $true

    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Http "$OllamaUrl/api/tags")) {
        if ((Get-Date) -gt $deadline) { throw "ollama did not come up on $OllamaUrl (see runtime\logs\ollama.err.log)" }
        Start-Sleep -Seconds 1
    }
    Ok 'ollama serve ready'
} else {
    Ok "using already-running Ollama at $OllamaUrl"
    if ($GpuDevices -or $TensorParallel) {
        Note 'it was started outside Jun, so it has its own environment - the GPU settings above do not apply to it'
    }
    $p = Get-TrackedProcess $oldPids 'ollama'
    if ($p) { $newPids['ollama'] = $p.Id }
}

$chatModel = ''
if ($env:OLLAMA_MODELS_TO_PULL) {
    foreach ($raw in $env:OLLAMA_MODELS_TO_PULL -split ',') {
        $m = $raw.Trim()
        if (-not $m) { continue }
        Step "pull $m"
        & ollama pull $m
        if ($LASTEXITCODE -ne 0 -and $m -match '^hf\.co/') {
            # Older Ollama builds reject the hf.co alias ("realm host
            # huggingface.co does not match original host hf.co").
            $m = $m -replace '^hf\.co/', 'huggingface.co/'
            Note "retrying as $m"
            & ollama pull $m
        }
        if ($LASTEXITCODE -ne 0) { Warn_ "pull failed: $m (continuing)" }
        if (-not $chatModel) { $chatModel = $m }
    }
}

# Pre-warm: an empty-prompt generate makes ollama load the chat model now, so
# the first real message doesn't pay the cold-load cost. Fire and forget - the
# short timeout aborts our wait, not the server-side load.
if ($chatModel -and $Provider -eq 'ollama') {
    Step "pre-warm $chatModel"
    Note 'loading model in the background'
    try {
        Invoke-RestMethod -Method Post -Uri "$OllamaUrl/api/generate" -ContentType 'application/json' `
            -Body (@{ model = $chatModel; prompt = ''; stream = $false } | ConvertTo-Json) -TimeoutSec 5 | Out-Null
    } catch {}
}
}

# Only when AI_PROVIDER=llamacpp and LLAMACPP_URL targets this machine; a
# remote/custom URL means the user runs their own server. Weights cache under
# runtime\llama-cache so they disappear with the folder on uninstall.
if ($Provider -eq 'llamacpp' -and $LlamacppUrl -match '://(127\.0\.0\.1|localhost)\b') {
    if (Test-Http "$LlamacppUrl/health") {
        Ok "using already-running llama-server at $LlamacppUrl"
        $p = Get-TrackedProcess $oldPids 'llamacpp'
        if ($p) { $newPids['llamacpp'] = $p.Id }
    } else {
        if (-not (Get-Command llama-server -ErrorAction SilentlyContinue)) {
            throw 'llama-server is not installed. Run install.ps1 first (it installs llama.cpp via winget).'
        }
        $hfRef = if ($env:LLAMACPP_MODEL_HF) { $env:LLAMACPP_MODEL_HF } else { 'efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M' }
        Step "start llama-server ($hfRef)"
        Note 'first run downloads the model'
        $env:LLAMA_CACHE = Join-Path $Runtime 'llama-cache'
        $llamaArgs = @('-hf', $hfRef, '--host', '127.0.0.1', '--port', $LlamaPort, '-c', '16384', '--jinja')
        if ($TensorParallel) { $llamaArgs += @('-sm', 'row') }
        $llamaProc = Start-Tracked 'llamacpp' 'llama-server' $llamaArgs

        # Generous deadline: the first boot downloads the GGUF before /health
        # goes green. A dead process fails fast instead of waiting it out.
        $deadline = (Get-Date).AddMinutes(15)
        while (-not (Test-Http "$LlamacppUrl/health")) {
            if ($llamaProc.HasExited) { throw "llama-server exited (code $($llamaProc.ExitCode)) - see runtime\logs\llamacpp.err.log" }
            if ((Get-Date) -gt $deadline) { throw "llama-server did not come up on $LlamacppUrl (see runtime\logs\llamacpp.err.log)" }
            Start-Sleep -Seconds 2
        }
        Ok 'llama-server ready'
    }
}

$ttsPython = Join-Path $Runtime 'tts-venv\Scripts\python.exe'
$voiceOff = $env:VOICE -and $env:VOICE.ToLower() -match '^(off|0|false|no)$'
if (-not $voiceOff -and (Test-Path $ttsPython)) {
    $p = Get-TrackedProcess $oldPids 'tts'
    if ($p) {
        $newPids['tts'] = $p.Id
        Ok 'TTS already running'
    } else {
        Step 'start TTS sidecar'
        Note 'first run downloads voice models'
        $env:TTS_HOST    = '127.0.0.1'
        $env:TTS_PORT    = '8001'
        $env:CORS_ORIGIN = $SiteUrl
        $env:HF_HOME     = Join-Path $Runtime 'hf-cache'
        Start-Tracked 'tts' $ttsPython @((Join-Path $PSScriptRoot 'tts\server.py')) | Out-Null
    }
} elseif (-not $voiceOff) {
    Warn_ 'voice is on but the TTS venv is missing - re-run install.ps1 to set it up. Continuing text-only.'
}

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

Step "start web server on $SiteUrl"
$env:AI_PROVIDER            = $Provider
$env:OLLAMA_URL             = $OllamaUrl
$env:LLAMACPP_URL           = $LlamacppUrl
$env:TTS_URL                = 'http://127.0.0.1:8001'
$env:OMEGA_STATE_DIR        = $StateDir
$libPath = (Join-Path $PSScriptRoot 'webapp\api\_lib.php').Replace('\', '/')
& $phpExe -r "require '$libPath'; db();"
if ($LASTEXITCODE -ne 0) { throw 'database migration failed' }
$oldMemory = Get-TrackedProcess $oldPids 'memory'
if ($oldMemory) { Stop-Process -Id $oldMemory.Id -Force -ErrorAction SilentlyContinue }
Start-Tracked 'memory' $phpExe @((Join-Path $PSScriptRoot 'webapp\api\consolidation-worker.php')) | Out-Null
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
            Write-Host "    ${DIM}--- last lines of runtime\logs\php.err.log ---${R}"
            Get-Content $err -Tail 10 | ForEach-Object { Write-Host "    ${DIM}$_${R}" }
        }
        $why = if ($phpProc.HasExited) { "php exited (code $($phpProc.ExitCode))" } else { 'timed out' }
        throw "web server did not come up on ${SiteUrl}: $why"
    }
    Start-Sleep -Seconds 1
}

Write-Host ''
Write-Host "  ${OK}▸${R} ${B}${OK}ready${R} ${DIM}-${R} open ${B}${ACCENT}${SiteUrl}${R}"
Note 'stop with: ./start.ps1 stop   |   logs: runtime\logs\'
if (-not $NoBrowser) { Start-Process $SiteUrl }
exit 0

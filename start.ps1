[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $OutputEncoding = [Text.Encoding]::UTF8
} catch {}

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
# UUIDs, NOT indices. nvidia-smi enumerates by PCI bus order while CUDA sorts
# by speed, so the same index means different cards to the two of them. great.
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

# the card the MTP tune was measured on, as one string: the vendor,
# then every GPU's name and how much VRAM it has. sorted biggest
# card first, so shuffling cards between slots isn't a change. only
# a real swap is.
#
# keep this in step with the copy in mtp-autotune.ps1. we compare
# what it prints against MTP_TUNED_GPU, so the day the two print a
# different string for the same card, every boot reads as a GPU
# change and re-runs the whole sweep. forever.
#
# there's no rocm-smi branch on windows bare metal, so an AMD box
# gets '' here. no stamp, and no automatic re-tune either.
function Get-GpuSignature {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return '' }
    $rows = @(& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null |
        ForEach-Object { $_.Trim() } | Where-Object { $_ -match ',' })
    if ($rows.Count -eq 0) { return '' }
    $cards = @($rows | ForEach-Object {
        $f = $_ -split ',', 2
        [pscustomobject]@{ Mb = [int]($f[1].Trim()); Text = ($f[0].Trim() + ':' + $f[1].Trim()) }
    } | Sort-Object Mb -Descending | ForEach-Object { $_.Text })
    return 'nvidia:' + ($cards -join ',')
}

$Runtime  = Join-Path $PSScriptRoot 'runtime'
$LogDir   = Join-Path $Runtime 'logs'
$PidFile  = Join-Path $Runtime 'pids.json'
$StateDir = Join-Path $Runtime 'state'

# read KEY=VALUE pairs in as env vars, but ONLY when they aren't set already,
# so you can still override one for a single run.
if (Test-Path .env) {
    foreach ($line in Get-Content .env) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $k = $Matches[1]; $v = $Matches[2].Trim()
            # the docker hostnames in .env.example mean nothing on bare
            # metal, so skip them and use our own localhost defaults.
            if ($v -match '://(ollama|tts|kokoro|karaoke|nginx|php|llamacpp)\b') { continue }
            if (-not (Get-Item "env:$k" -ErrorAction SilentlyContinue)) {
                Set-Item "env:$k" $v
            }
        }
    }
}

$Port      = if ($env:JUN_PORT) { $env:JUN_PORT } else { '8080' }
$OllamaUrl = if ($env:OLLAMA_URL) { $env:OLLAMA_URL } else { 'http://127.0.0.1:11434' }
# SiteUrl stays loopback whatever we bind to. it is what the health probe
# polls, what the browser opens and what CORS_ORIGIN gets, and all three of
# those are this machine talking to itself.
$SiteUrl   = "http://127.0.0.1:$Port"
$BindAddr  = if ($env:BIND_ADDR) { $env:BIND_ADDR.Trim() } else { '127.0.0.1' }
$LanHosts  = @()

# this box's own addresses on the home network. skips the virtual adapters
# Hyper-V, WSL and Docker Desktop leave lying around, those aren't reachable
# from a phone and naming them just widens the Host allowlist for nothing.
function Get-PrivateIPv4 {
    try {
        @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object {
                $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and
                $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|Hyper-V|VirtualBox|VMware'
            } | Select-Object -ExpandProperty IPAddress -Unique)
    } catch { @() }
}

function Test-Elevated {
    try {
        $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        return $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

# binding to 0.0.0.0 is only half of it on windows. the firewall drops the
# inbound connection before php ever sees it, so the phone just hangs with no
# error anywhere. Private profile ONLY - this must not follow you onto cafe
# wifi. delete it with:
#   Remove-NetFirewallRule -DisplayName "Jun OS (<port>)"
function Confirm-FirewallRule([string]$port) {
    $ruleName = "Jun OS ($port)"
    if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) {
        Warn_ "no NetSecurity module here, so open TCP $port on private networks yourself"
        return
    }
    try {
        if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
            Note "firewall rule '$ruleName' is already there"
            return
        }
    } catch {
        Warn_ "could not read the firewall rules: $($_.Exception.Message)"
        return
    }
    if (Test-Elevated) {
        try {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $port -Profile Private -ErrorAction Stop | Out-Null
            Ok "opened TCP $port on private networks (rule '$ruleName')"
        } catch {
            Warn_ "could not add the firewall rule: $($_.Exception.Message)"
        }
    } else {
        Warn_ 'windows firewall will block the phone. run this once in an admin PowerShell:'
        Note "New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private"
    }
}

if ($Action -eq 'start' -and $BindAddr -notin @('127.0.0.1', 'localhost', '::1')) {
    # bare metal has no TLS at all - no nginx, no certs, php -S speaks plain
    # HTTP and nothing else. so this is the same refusal the docker path makes,
    # except here there is no TLS_MODE=on to offer as the way out.
    if ($env:OMEGA_ALLOW_INSECURE_PUBLIC_HTTP -ne '1') {
        Fail_ "refusing to serve login and chat over plain HTTP on $BindAddr."
        Note 'bare metal has no TLS. set OMEGA_ALLOW_INSECURE_PUBLIC_HTTP=1 in .env if your'
        Note 'network is one you trust, and know that passwords and chats cross it in the clear.'
        exit 1
    }
    Warn_ 'OMEGA_ALLOW_INSECURE_PUBLIC_HTTP=1 - passwords, sessions and chats are not encrypted.'
    $LanHosts = @(Get-PrivateIPv4)
    # php's built-in server is single-worker on windows (PHP_CLI_SERVER_WORKERS
    # is a unix-only knob), so the phone and the desktop are not two users, they
    # are one queue. whoever asks second waits out the first reply's whole
    # stream. docker doesn't have this problem, php-fpm forks.
    Note 'one request at a time on windows - a second device waits for the first reply to finish'
    Confirm-FirewallRule $Port
}

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
# an empty CUDA_VISIBLE_DEVICES means NO GPUs, not all of them, so only set it
# when we actually have a list. the model servers pick it up from here.
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

# the draft depth in .env is a measurement, and it only describes
# the card it was measured on. swap the GPU and that number is
# about hardware that left the building. so hold the stamp the
# tuner wrote against what's in the box NOW and measure again when
# the two don't match.
function Invoke-MtpRecheck {
    # on the llamacpp side the tuner restarts the stack through
    # start.ps1, which is us. without this we start a tune inside
    # a tune. forever.
    if ($env:MTP_AUTOTUNE_RUNNING) { return }
    if ($env:MTP_AUTOTUNE -and $env:MTP_AUTOTUNE.ToLower() -match '^(off|0|false|no)$') { return }

    # no stamp means no tune ever finished on this box, so there's
    # nothing to compare and nothing to nag about.
    $tuned = $env:MTP_TUNED_GPU
    if (-not $tuned) { return }
    $sig = Get-GpuSignature
    if (-not $sig -or $sig -eq $tuned) { return }

    $drafter = ''
    switch ($Provider) {
        'llamacpp' { $drafter = $env:LLAMACPP_MTP }
        'ollama'   { $drafter = $env:OLLAMA_MTP }
        default    { return }
    }
    # MTP is off so there's no depth to measure. the tuner would
    # just die on it and we'd be back here every single boot.
    if (-not $drafter) { return }

    Step 'the GPU changed since MTP was tuned'
    Note "tuned on: $tuned"
    Note "here now: $sig"
    Note 'the draft depth in .env was measured on a card that is not in this box any more, so we are measuring it again'
    Note 'a few minutes on ollama, considerably longer on llamacpp where every depth needs a llama-server restart'
    Note 'set MTP_AUTOTUNE=off in .env to skip this'

    # /api/tags answers the moment ollama is up, which tells us
    # NOTHING about whether the drafter is pulled yet. the tuner
    # needs that blob on disk or it dies with "could not find the
    # drafter blob", so wait until ollama show admits it has one.
    $deadline = (Get-Date).AddMinutes(5)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($Provider -eq 'llamacpp') {
            if (Test-Http "$LlamacppUrl/health") { $ready = $true; break }
        } elseif (Test-Http "$OllamaUrl/api/tags") {
            # PS 7.4 turns a non-zero exit from a native command into
            # a throw under ErrorActionPreference Stop, and "not pulled
            # yet" is the NORMAL answer in here, not an error.
            try {
                & ollama show --modelfile $drafter 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            } catch {}
        }
        Start-Sleep -Seconds 5
    }

    # leave the stamp stale ON PURPOSE. it's the only thing that
    # makes the next boot try again, and a pull that's still
    # running now is probably done by then.
    if (-not $ready) {
        Warn_ 'the drafter is not here yet, so the re-tune is skipped. run .\mtp-autotune.ps1 by hand once it has finished pulling.'
        return
    }

    try {
        $env:MTP_AUTOTUNE_RUNNING = '1'
        & "$PSScriptRoot\mtp-autotune.ps1"
    } catch {
        Warn_ "autotune did not finish, run .\mtp-autotune.ps1 by hand ($_)"
    } finally {
        Remove-Item env:MTP_AUTOTUNE_RUNNING -ErrorAction SilentlyContinue
        # the tuner just wrote .env and the copy we read at startup
        # is older than that. drop it, so a second start.ps1 in the
        # same session picks the new stamp up off disk instead of
        # re-running the whole sweep against a stale value.
        Remove-Item env:MTP_TUNED_GPU -ErrorAction SilentlyContinue
    }
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

# if an Ollama server is already up (the desktop app autostarts one) just use
# it. otherwise launch `ollama serve` ourselves, with the model store inside
# the install folder so the weights go away with it on uninstall.
if ($Provider -eq 'ollama') {
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    throw 'ollama is not installed. Run install.ps1 first (it installs Ollama via winget).'
}

$ownOllama = $false
if (-not (Test-Http "$OllamaUrl/api/tags")) {
    Step 'start ollama serve'
    $env:OLLAMA_HOST   = '127.0.0.1:11434'
    $env:OLLAMA_MODELS = Join-Path $Runtime 'ollama-models'
    # memory caps, same reasoning as the docker setup. one slot, two models,
    # 8-bit KV cache. needs flash attention, falls back to f16 elsewhere.
    if (-not $env:OLLAMA_NUM_PARALLEL)      { $env:OLLAMA_NUM_PARALLEL = '1' }
    if (-not $env:OLLAMA_MAX_LOADED_MODELS) { $env:OLLAMA_MAX_LOADED_MODELS = '2' }
    if (-not $env:OLLAMA_KEEP_ALIVE)        { $env:OLLAMA_KEEP_ALIVE = '5m' }
    if (-not $env:OLLAMA_FLASH_ATTENTION)   { $env:OLLAMA_FLASH_ATTENTION = '1' }
    if (-not $env:OLLAMA_KV_CACHE_TYPE)     { $env:OLLAMA_KV_CACHE_TYPE = 'q8_0' }
    # Ollama has no real tensor parallelism. spreading the layers is as close
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
            # older Ollama builds reject the hf.co alias ("realm host
            # huggingface.co does not match original host hf.co").
            $m = $m -replace '^hf\.co/', 'huggingface.co/'
            Note "retrying as $m"
            & ollama pull $m
        }
        if ($LASTEXITCODE -ne 0) { Warn_ "pull failed: $m (continuing)" }
        if (-not $chatModel) { $chatModel = $m }
    }
}

# pre-warm. an empty-prompt generate makes ollama load the chat model NOW, so
# the first real message doesn't eat the cold-load cost. fire and forget, the
# short timeout aborts OUR wait, not the server-side load.
if ($chatModel -and $Provider -eq 'ollama') {
    Step "pre-warm $chatModel"
    Note 'loading model in the background'
    try {
        Invoke-RestMethod -Method Post -Uri "$OllamaUrl/api/generate" -ContentType 'application/json' `
            -Body (@{ model = $chatModel; prompt = ''; stream = $false } | ConvertTo-Json) -TimeoutSec 5 | Out-Null
    } catch {}
}
}

# only when AI_PROVIDER=llamacpp and LLAMACPP_URL points at this machine. a
# remote/custom URL means the user runs their own server. weights cache under
# runtime\llama-cache so they go away with the folder on uninstall.
if ($Provider -eq 'llamacpp' -and $LlamacppUrl -match '://(127\.0\.0\.1|localhost)\b') {
    if (Test-Http "$LlamacppUrl/health") {
        Ok "using already-running llama-server at $LlamacppUrl"
        $p = Get-TrackedProcess $oldPids 'llamacpp'
        if ($p) { $newPids['llamacpp'] = $p.Id }
    } else {
        if (-not (Get-Command llama-server -ErrorAction SilentlyContinue)) {
            throw 'llama-server is not installed. Run install.ps1 first (it installs llama.cpp via winget).'
        }
        $hfRef = if ($env:LLAMACPP_MODEL_HF) { $env:LLAMACPP_MODEL_HF } else { 'efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M' }
        Step "start llama-server ($hfRef)"
        Note 'first run downloads the model'
        $env:LLAMA_CACHE = Join-Path $Runtime 'llama-cache'
        $llamaArgs = @('-hf', $hfRef, '--host', '127.0.0.1', '--port', $LlamaPort, '-c', '16384', '--jinja')
        if ($TensorParallel) { $llamaArgs += @('-sm', 'row') }
        # Gemma 4's multi-token prediction. the assistant model guesses the
        # next few tokens, the real model checks them all in one pass, and the
        # ones it got right came almost free. LLAMACPP_MTP holds the drafter's
        # HF repo, the first run downloads that one too.
        if ($env:LLAMACPP_MTP) {
            $nMax = if ($env:LLAMACPP_MTP_N_MAX) { $env:LLAMACPP_MTP_N_MAX } else { '4' }
            $llamaArgs += @('--spec-type', 'draft-mtp', '-hfd', $env:LLAMACPP_MTP, '--spec-draft-n-max', $nMax)
        }
        $llamaProc = Start-Tracked 'llamacpp' 'llama-server' $llamaArgs

        # generous deadline, the first boot downloads the GGUF before /health
        # goes green. a dead process fails fast instead of waiting it out.
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

# sanity-check php.exe before launching it hidden. a missing VC++ runtime
# kills it with NO visible error (NTSTATUS 0xC0000135 = missing DLL).
# run through cmd so PHP warnings on stderr can't trip ErrorActionPreference.
cmd /c "`"$phpExe`" -v >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    if ($LASTEXITCODE -eq -1073741515) {
        throw "php.exe can't start: the Microsoft Visual C++ runtime is missing. Install the 'Microsoft Visual C++ 2015-2022 Redistributable (x64)' (winget install Microsoft.VCRedist.2015+.x64) and re-run."
    }
    throw "php.exe failed its self-check (exit code $LASTEXITCODE). Try re-running install.ps1."
}

$listenLabel = if ($BindAddr -eq '127.0.0.1') { $SiteUrl } else { "${BindAddr}:${Port}" }
Step "start web server on $listenLabel"
$env:AI_PROVIDER            = $Provider
$env:OLLAMA_URL             = $OllamaUrl
$env:LLAMACPP_URL           = $LlamacppUrl
$env:TTS_URL                = 'http://127.0.0.1:8001'
# one sidecar process serves both roles here, unlike docker where karaoke gets
# its own (GPU-capable) container.
$env:KARAOKE_URL            = 'http://127.0.0.1:8001'
$env:OMEGA_STATE_DIR        = $StateDir
# php-router.php refuses any Host that isn't in here with a 421, so a phone
# opening http://192.168.1.42:8080 needs that exact address listed. filled in
# from this machine's own private addresses, plus OMEGA_EXTRA_HOSTS for what we
# can't guess (an mDNS name, a tailscale address).
$env:OMEGA_ALLOWED_HOSTS    = (@('127.0.0.1', 'localhost', '::1') + $LanHosts +
    @($env:OMEGA_EXTRA_HOSTS -split '[,\s]+' | Where-Object { $_ })) -join ','
$env:OMEGA_ALLOWED_ORIGINS  = $SiteUrl
$libPath = (Join-Path $PSScriptRoot 'webapp\api\_lib.php').Replace('\', '/')
& $phpExe -r "require '$libPath'; db();"
if ($LASTEXITCODE -ne 0) { throw 'database migration failed' }
$oldMemory = Get-TrackedProcess $oldPids 'memory'
if ($oldMemory) { Stop-Process -Id $oldMemory.Id -Force -ErrorAction SilentlyContinue }
Start-Tracked 'memory' $phpExe @((Join-Path $PSScriptRoot 'webapp\api\consolidation-worker.php')) | Out-Null
# PHP honors this on unix ONLY. on windows the built-in server stays
# single-worker, so requests made while a chat reply is streaming (TTS, say)
# just queue until it finishes. fine for a single local user.
$env:PHP_CLI_SERVER_WORKERS = '8'
$phpProc = Start-Tracked 'php' $phpExe @(
    '-S', "${BindAddr}:$Port",
    '-t', (Join-Path $PSScriptRoot 'webapp'),
    (Join-Path $PSScriptRoot 'tools\php-router.php')
)

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

# BEFORE the ready banner, not after. on llamacpp the sweep bounces
# llama-server five times, so she isn't usable till it finishes and
# opening the browser first would just show a broken chat.
Invoke-MtpRecheck

Write-Host ''
Write-Host "  ${OK}▸${R} ${B}${OK}ready${R} ${DIM}-${R} open ${B}${ACCENT}${SiteUrl}${R}"
foreach ($lan in $LanHosts) {
    Write-Host "    ${DIM}on your phone:${R} ${ACCENT}http://${lan}:${Port}${R} ${DIM}(same wifi)${R}"
}
Note 'stop with: ./start.ps1 stop   |   logs: runtime\logs\'
if (-not $NoBrowser) { Start-Process $SiteUrl }
exit 0

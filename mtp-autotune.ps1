#Requires -Version 5.1
<#
Find the draft depth that is actually fastest on THIS machine, then write it
into .env.

Speculation only pays when checking K+1 tokens costs about what checking 1
costs. Whether that holds depends on the card, so the only honest answer is to
measure. Measured on a 3060 with the 12B: depth 1 gave +25%, depth 2 +16%,
depth 3 broke even, depth 4 came out Slower than no drafter at all. A bigger
card can afford a deeper draft. Yours might not.

Needs the stack running and the models pulled. Safe to re-run any time. After a
GPU change you don't have to remember to, start.ps1 sees the card this was
measured on is gone and runs it for you.

  .\mtp-autotune.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$e = [char]27
$R = "$e[0m"; $B = "$e[1m"; $DIM = "$e[38;2;158;158;158m"
$OK = "$e[38;2;108;203;95m"; $WARN = "$e[38;2;252;225;0m"; $ACCENT = "$e[38;2;96;205;255m"

function Say([string]$m)   { Write-Host "    ${DIM}${m}${R}" }
function Good([string]$m)  { Write-Host "    ${OK}v${R} $m" }
function Warn_([string]$m) { Write-Host "    ${WARN}!${R} $m" }
function Die([string]$m)   { Write-Host "    ${WARN}!${R} $m"; exit 1 }

function Get-EnvKey([string]$key) {
    if (-not (Test-Path .env)) { return '' }
    $hit = Select-String -Path .env -Pattern "^$key=" -ErrorAction SilentlyContinue | Select-Object -Last 1
    if (-not $hit) { return '' }
    return ($hit.Line -replace "^$key=", '')
}

function Set-EnvKey([string]$key, [string]$val) {
    $lines = @()
    if (Test-Path .env) {
        $lines = @(Get-Content .env | Where-Object { $_ -notmatch "^$key=" })
    }
    $lines += "$key=$val"
    Set-Content -Path .env -Value $lines -Encoding UTF8
}

# The card this tune was measured on, as one string: the vendor,
# then every GPU's name and how much VRAM it has. Sorted biggest
# card first, so moving cards between slots is not a change, only
# a real swap is.
#
# Keep this in step with the copy in start.ps1. that one compares
# what it prints against MTP_TUNED_GPU, so the day the two print a
# different string for the same card, start.ps1 reads every boot
# as a GPU change and re-runs the whole sweep, forever.
#
# There is no rocm-smi branch on Windows bare metal, so an AMD box
# gets '' here: no stamp, and no automatic re-tune either.
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

# Only a run that measured something gets to stamp, and only when
# we could actually name the card. No stamp is better than one
# that means "we could not tell", start.ps1 has nothing to compare
# then and leaves you alone.
function Set-GpuStamp {
    $sig = Get-GpuSignature
    if ($sig) { Set-EnvKey 'MTP_TUNED_GPU' $sig }
}

# Two in-character turns, no code. A coding prompt makes any drafter look
# great, Gemma's assistants were tuned on code, and then the number you tuned
# against is one Jun's traffic NEVER sees. Prose is what she actually writes.
$Prompts = @(
    'You have been quiet all evening. Talk to me, properly.',
    'Tell me what you remember about the day we met.'
)

# 2 prompts x 80 tokens is 160 per row, five rows, so the whole ollama sweep
# lands near half a minute on a normal card. Short rows are noisier, that is
# what $Margin below is for, a depth that only ties inside the noise doesn't
# get to win anyway.
$Tokens = 80

# Her real system prompt goes in front of every one of those, because it goes in
# front of every real message too. Measured bare, depth 2 came out on top by 1%,
# measured with the prompt in place depth 1 won by 6% - same box, same drafter,
# same afternoon. Tuning without it picks the winner for a regime the app never
# runs in.
$SystemPrompt = ''
if (Test-Path 'webapp/system_prompt.txt') {
    $SystemPrompt = Get-Content 'webapp/system_prompt.txt' -Raw
}

function Get-Messages([string]$prompt) {
    if ($SystemPrompt) {
        return @(@{ role = 'system'; content = $SystemPrompt }, @{ role = 'user'; content = $prompt })
    }
    return @(@{ role = 'user'; content = $prompt })
}

# Anything under this much is noise on a warm box, and a deeper draft that only
# ties costs VRAM and gets worse the moment layers spill to the CPU. So a deeper
# one has to actually earn the spot, not tie for it.
$Margin = 1.02

function Test-Better([double]$a, [double]$b) { return ($a -gt ($b * $Margin)) }

# The drafter that goes with a chat model is the same repo with -MTP
# in the name, so Jun-LoRA-12B-GGUF drafts off Jun-LoRA-12B-MTP-GGUF.
# The quant tag rides along untouched. A repo that doesn't end in
# -GGUF just gets -MTP on the end.
function Get-MtpRepo([string]$ref) {
    $tag = ''
    $repo = $ref
    $slash = $ref.LastIndexOf('/')
    $colon = $ref.LastIndexOf(':')
    if ($colon -gt $slash) { $tag = $ref.Substring($colon); $repo = $ref.Substring(0, $colon) }
    if ($repo -match '-GGUF$') { return ($repo -replace '-GGUF$', '-MTP-GGUF') + $tag }
    return "$repo-MTP$tag"
}

# tok/s pooled over both prompts. Ollama reports eval_count and
# eval_duration per request, so this counts generation only and leaves prompt
# processing out of it.
function Measure-Ollama([string]$model, [string]$url) {
    $tok = 0; $ns = 0.0
    foreach ($p in $Prompts) {
        $body = @{
            model = $model; stream = $false
            messages = Get-Messages $p
            options = @{ temperature = 0; num_predict = $Tokens }
        } | ConvertTo-Json -Depth 5
        try {
            $r = Invoke-RestMethod -Method Post -Uri "$url/api/chat" -ContentType 'application/json' `
                -Body $body -TimeoutSec 300
        } catch { continue }
        if (-not $r.eval_count -or -not $r.eval_duration) { continue }
        $tok += [int]$r.eval_count
        $ns  += [double]$r.eval_duration
    }
    if ($ns -le 0) { return 0.0 }
    return [math]::Round($tok / ($ns / 1e9), 2)
}

function Tune-Ollama {
    $url = Get-EnvKey 'OLLAMA_URL'
    if (-not $url -or $url -match '://ollama\b') { $url = 'http://127.0.0.1:11434' }
    $chat = Get-EnvKey 'OLLAMA_MODELS_TO_PULL'
    $drafter = Get-EnvKey 'OLLAMA_MTP'
    $mtpModel = Get-EnvKey 'OLLAMA_MTP_MODEL'
    if (-not $mtpModel) { $mtpModel = 'jun-mtp' }

    if (-not $chat) { Die 'OLLAMA_MODELS_TO_PULL is empty.' }
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Die 'ollama is not installed.' }

    if (-not $drafter) {
        $drafter = Get-MtpRepo $chat
        Say "no OLLAMA_MTP set, trying $drafter"
        & ollama pull $drafter 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { Die "$drafter is not there - set OLLAMA_MTP by hand if the drafter lives somewhere else." }
        Set-EnvKey 'OLLAMA_MTP' $drafter
    }

    # DRAFT wants a path to a gguf, a model name is rejected. For a gguf-only
    # pull the blob ollama landed it in IS the gguf, and the modelfile is where
    # it admits which blob that was.
    $blob = (& ollama show --modelfile $drafter 2>$null |
        Where-Object { $_ -match '^FROM ' } | Select-Object -First 1) -replace '^FROM\s+', ''
    if (-not $blob -or -not (Test-Path $blob)) { Die "could not find the drafter blob for $drafter - is it pulled?" }

    Write-Host ''
    Write-Host "     ${B}measuring${R} ${DIM}(a few seconds per row)${R}"
    $base = Measure-Ollama $chat $url
    Write-Host "       ${DIM}no drafter${R}   $base tok/s"
    # A baseline of zero means every request failed, not that she is infinitely
    # slow. Carrying on from here would read the silence as "drafting never
    # helps" and switch the feature off on the strength of nothing.
    if ($base -le 0) { Die "could not measure a baseline - is $chat pulled and ollama running?" }

    $bestN = 0; $best = $base
    $mf = Join-Path $env:TEMP 'Modelfile.tune'
    foreach ($n in 1..4) {
        "FROM $chat`nDRAFT $blob`nPARAMETER draft_num_predict $n" | Set-Content -Path $mf -Encoding UTF8
        & ollama create jun-mtp-tune -f $mf 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { Warn_ "depth $n failed to build, skipping"; continue }
        $got = Measure-Ollama 'jun-mtp-tune' $url
        Write-Host "       ${DIM}draft $n${R}     $got tok/s"
        if (Test-Better $got $best) { $best = $got; $bestN = $n }
    }
    & ollama rm jun-mtp-tune 2>$null | Out-Null

    if ($bestN -eq 0) {
        Warn_ 'no draft depth beat plain decoding here - leaving MTP off.'
        Set-EnvKey 'OLLAMA_MTP' ''
        Set-GpuStamp
        Say 'the drafter stays pulled, put OLLAMA_MTP back to try again.'
        return
    }

    "FROM $chat`nDRAFT $blob`nPARAMETER draft_num_predict $bestN" | Set-Content -Path $mf -Encoding UTF8
    & ollama create $mtpModel -f $mf 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "could not rebuild $mtpModel at depth $bestN" }

    Set-EnvKey 'OLLAMA_MTP_N_MAX' "$bestN"
    $gain = if ($base -gt 0) { [math]::Round(($best / $base - 1) * 100) } else { 0 }
    Good "draft $bestN wins: $best tok/s, $gain% over plain decoding"
    Set-GpuStamp
}

function Measure-Llamacpp([string]$url) {
    $tok = 0; $ms = 0.0
    foreach ($p in $Prompts) {
        $body = @{
            stream = $false
            messages = Get-Messages $p
            temperature = 0; max_tokens = $Tokens
        } | ConvertTo-Json -Depth 5
        try {
            $r = Invoke-RestMethod -Method Post -Uri "$url/v1/chat/completions" -ContentType 'application/json' `
                -Body $body -TimeoutSec 300
        } catch { continue }
        if (-not $r.usage.completion_tokens -or -not $r.timings.predicted_ms) { continue }
        $tok += [int]$r.usage.completion_tokens
        $ms  += [double]$r.timings.predicted_ms
    }
    if ($ms -le 0) { return 0.0 }
    return [math]::Round($tok / ($ms / 1000), 2)
}

# start.ps1 re-runs this script when the GPU stamp is stale, and the
# stamp stays stale until the sweep ends. so every restart in here
# has to say "already tuning", otherwise the first one starts a
# second sweep inside this one.
function Restart-Llamacpp([string]$url) {
    $prev = $env:MTP_AUTOTUNE_RUNNING
    $env:MTP_AUTOTUNE_RUNNING = '1'
    try {
        & "$PSScriptRoot\start.ps1" stop | Out-Null
        & "$PSScriptRoot\start.ps1" -NoBrowser | Out-Null
    } finally {
        if ($prev) { $env:MTP_AUTOTUNE_RUNNING = $prev }
        else { Remove-Item env:MTP_AUTOTUNE_RUNNING -ErrorAction SilentlyContinue }
    }
    $deadline = (Get-Date).AddMinutes(15)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri "$url/health" -TimeoutSec 3 -UseBasicParsing | Out-Null
            return $true
        } catch { Start-Sleep -Seconds 2 }
    }
    Warn_ 'llama-server did not come back healthy'
    return $false
}

# llama-server takes the draft depth as a startup flag, so unlike ollama there
# is no way to swap it on a live server. Every row down here is a full restart,
# which is why this half is the slow one.
function Tune-Llamacpp {
    $url = Get-EnvKey 'LLAMACPP_URL'
    if (-not $url) { $url = 'http://127.0.0.1:8081' }
    $drafter = Get-EnvKey 'LLAMACPP_MTP'
    if (-not $drafter) {
        $chat = Get-EnvKey 'LLAMACPP_MODEL_HF'
        if (-not $chat) { Die 'LLAMACPP_MTP is empty and LLAMACPP_MODEL_HF names nothing to derive it from.' }
        $drafter = Get-MtpRepo $chat
        Say "no LLAMACPP_MTP set, trying $drafter"
        Set-EnvKey 'LLAMACPP_MTP' $drafter
    }
    $keepN = Get-EnvKey 'LLAMACPP_MTP_N_MAX'

    Write-Host ''
    Write-Host "     ${B}measuring${R} ${DIM}(each row restarts llama-server, this takes a while)${R}"

    Set-EnvKey 'LLAMACPP_MTP' ''
    if (-not (Restart-Llamacpp $url)) { Set-EnvKey 'LLAMACPP_MTP' $drafter; Die 'could not get a baseline' }
    $base = Measure-Llamacpp $url
    Write-Host "       ${DIM}no drafter${R}   $base tok/s"
    if ($base -le 0) { Set-EnvKey 'LLAMACPP_MTP' $drafter; Die 'could not measure a baseline - is llama-server healthy?' }

    Set-EnvKey 'LLAMACPP_MTP' $drafter
    $bestN = 0; $best = $base
    foreach ($n in 1..4) {
        Set-EnvKey 'LLAMACPP_MTP_N_MAX' "$n"
        if (Restart-Llamacpp $url) {
            $got = Measure-Llamacpp $url
            Write-Host "       ${DIM}draft $n${R}     $got tok/s"
            if (Test-Better $got $best) { $best = $got; $bestN = $n }
        } else {
            Warn_ "depth $n did not start, skipping"
        }
    }

    if ($bestN -eq 0) {
        Warn_ 'no draft depth beat plain decoding here - leaving MTP off.'
        Set-EnvKey 'LLAMACPP_MTP' ''
        Set-EnvKey 'LLAMACPP_MTP_N_MAX' $(if ($keepN) { $keepN } else { '1' })
        Set-GpuStamp
        Restart-Llamacpp $url | Out-Null
        return
    }

    Set-EnvKey 'LLAMACPP_MTP_N_MAX' "$bestN"
    Restart-Llamacpp $url | Out-Null
    $gain = if ($base -gt 0) { [math]::Round(($best / $base - 1) * 100) } else { 0 }
    Good "draft $bestN wins: $best tok/s, $gain% over plain decoding"
    Set-GpuStamp
}

Write-Host ''
Write-Host "  ${ACCENT}>${R} ${B}multi-token prediction autotune${R}"

switch ((Get-EnvKey 'AI_PROVIDER')) {
    'ollama'   { Tune-Ollama }
    'llamacpp' { Tune-Llamacpp }
    default    { Die 'AI_PROVIDER is not ollama or llamacpp - MTP does not apply.' }
}

# The sweep runs on an idle card. Once a browser is drawing Live2D it takes
# about 1.5GB of the same VRAM, and if that pushes layers onto the CPU every
# number above shifts down. Deeper drafts got Worse under that pressure when it
# was measured, not better, so the winner still holds.
Say 'measured with nothing else on the GPU. Live2D in a browser wants ~1.5GB more.'
Write-Host ''

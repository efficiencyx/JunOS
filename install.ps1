$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Ensure Unicode glyphs render correctly on all console hosts.
try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $OutputEncoding = [Text.Encoding]::UTF8
} catch {}

$repo = if ($env:JUN_REPO) { $env:JUN_REPO } else { 'https://github.com/efficiencyx/Jun.git' }
$dir  = if ($env:JUN_DIR)  { $env:JUN_DIR }  else { 'Jun' }
$ref  = if ($env:JUN_REF)  { $env:JUN_REF }  else { 'main' }

# ── ANSI / VT escape setup ───────────────────────────────────────────────────
# Windows Terminal, VS Code, and modern conhost all handle VT sequences.
# Detect support and fall back to unstyled text gracefully.
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
    $FRAME  = "$e[38;2;80;80;80m"      # #505050  Card border
} else {
    $R = ''; $B = ''; $D = ''; $ACCENT = ''; $BLUE = ''; $OK = ''
    $DANGER = ''; $WARN = ''; $DIM = ''; $MUTED = ''; $FRAME = ''
}

$UI_W = 54   # interior width of the card frame

function _Rule([string]$ch) { $ch * $UI_W }

function Show-Banner {
    $blank = ' ' * $UI_W
    $bar   = _Rule '═'
    Write-Host ''
    Write-Host "  ${FRAME}╔${bar}╗${R}"
    Write-Host "  ${FRAME}║${R}${blank}${FRAME}║${R}"
    # "    Ω  JUN OS" = 13 visible chars
    Write-Host "  ${FRAME}║${R}    ${B}${BLUE}Ω${R}  ${B}${ACCENT}JUN OS${R}$(' ' * ($UI_W - 13))${FRAME}║${R}"
    Write-Host "  ${FRAME}║${R}${blank}${FRAME}║${R}"
    # "    Welcome to Jun OS · omega build" = 35 visible chars
    Write-Host "  ${FRAME}║${R}    ${MUTED}Welcome to Jun OS${R} ${DIM}·${R} ${DIM}omega build${R}$(' ' * ($UI_W - 35))${FRAME}║${R}"
    # "    Windows installer" = 21 visible chars
    Write-Host "  ${FRAME}║${R}    ${DIM}Windows installer${R}$(' ' * ($UI_W - 21))${FRAME}║${R}"
    Write-Host "  ${FRAME}║${R}${blank}${FRAME}║${R}"
    Write-Host "  ${FRAME}╚${bar}╝${R}"
    Write-Host ''
}

function Step([string]$msg)    { Write-Host "  ${ACCENT}▸${R} ${B}${msg}${R}" }
function Ok([string]$msg)      { Write-Host "    ${OK}✓${R} ${MUTED}${msg}${R}" }
function Note([string]$msg)    { Write-Host "    ${DIM}ℹ ${msg}${R}" }
function Warn_([string]$msg)   { Write-Host "    ${WARN}⚠${R} ${WARN}${msg}${R}" }
function Fail_([string]$msg)   { Write-Host "    ${DANGER}✗${R} ${DANGER}${msg}${R}" }

# Read a line of input after a styled prompt (avoids the ': ' suffix of Read-Host).
function Read-Styled([string]$prompt) {
    Write-Host -NoNewline $prompt
    try { return [Console]::ReadLine() }
    catch { return (Read-Host) }
}

# ── end UI helpers ────────────────────────────────────────────────────────────

$wingetIds = @{ git = 'Git.Git'; ollama = 'Ollama.Ollama'; python = 'Python.Python.3.11'; llamacpp = 'ggml.llamacpp' }
$manualUrls = @{
    git      = 'https://git-scm.com/download/win'
    ollama   = 'https://ollama.com/download/windows'
    python   = 'https://www.python.org/downloads/windows/'
    llamacpp = 'https://github.com/ggml-org/llama.cpp/releases'
}

$models = @{
    '12b' = 'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q4_K_M'
    'e4b' = 'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q4_K_M'
    'e2b' = 'hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M'
}

function Resolve-Model([string]$a) {
    switch -Regex ($a.ToLower()) {
        '^(12b|jun|best)$'     { return $models['12b'] }
        '^(e4b|balanced|fast)$' { return $models['e4b'] }
        '^(e2b|fastest|cpu)$'  { return $models['e2b'] }
        default                { return $a }
    }
}

function Get-GpuMemoryMb {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return @() }
    $out = & nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
    return @($out | Where-Object { $_ -match '\d' } | ForEach-Object { [int]($_.Trim()) })
}

function Get-VramMb {
    $mb = @(Get-GpuMemoryMb)
    if ($mb.Count -eq 0) { return $null }
    return [int](($mb | Measure-Object -Maximum).Maximum)
}

function Get-VramTotalMb {
    $mb = @(Get-GpuMemoryMb)
    if ($mb.Count -eq 0) { return $null }
    return [int](($mb | Measure-Object -Sum).Sum)
}

function Get-GpuCount { return @(Get-GpuMemoryMb).Count }

function Recommend-Alias([int]$mb) {
    if ($mb -ge 23500) { return 'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q8_0' }
    if ($mb -ge 15500) { return 'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q6_K' }
    if ($mb -ge 11500) { return $models['12b'] }
    if ($mb -ge 9500) { return 'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q8_0' }
    if ($mb -ge 7500) { return $models['e4b'] }
    if ($mb -ge 5500) { return 'hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q6_K' }
    return $models['e2b']
}

function Set-EnvKey([string]$key, [string]$val) {
    $lines = @()
    if (Test-Path .env) { $lines = Get-Content .env | Where-Object { $_ -notmatch "^$key=" } }
    $lines += "$key=$val"
    Set-Content -Path .env -Value $lines
}

$interactive = [Environment]::UserInteractive -and ($env:JUN_YES -ne '1')

# First choice a non-technical user sees: Express installs everything with
# detected defaults and asks nothing further (same effect as JUN_YES=1); Custom
# walks the prompts. JUN_EXPRESS=1 selects Express up front.
function Choose-InstallMode {
    if ($env:JUN_YES -eq '1') { return }
    if ($env:JUN_EXPRESS -match '^(1|on|yes|true)$') {
        $env:JUN_YES = '1'; $script:interactive = $false; return
    }
    if (-not [Environment]::UserInteractive) { return }
    Write-Host ''
    Write-Host "     ${B}how should I install?${R}"
    Write-Host "       ${ACCENT}[1]${R}  Express  ${DIM}- everything with recommended settings${R} ${DIM}(default)${R}"
    Write-Host "       ${ACCENT}[2]${R}  Custom   ${DIM}- pick the provider, model, voice, and more${R}"
    $ans = Read-Styled "     ${OK}▸${R} choice ${DIM}[Enter = Express]${R} ${ACCENT}›${R} "
    if ($ans -match '^(2|custom)$') {
        Note "custom install - I'll ask about each option below"
    } else {
        $env:JUN_YES = '1'; $script:interactive = $false
        Ok 'express install - using recommended settings'
    }
}

function Ask-ModelRef {
    $gpus = Get-GpuCount
    $vram = if ($script:tensorParallel -eq 'on') { Get-VramTotalMb } else { Get-VramMb }
    $rec  = if ($null -ne $vram) { Recommend-Alias $vram } else { $models['e2b'] }

    $alias = $env:JUN_MODEL
    if (-not $alias) {
        if ($interactive) {
            Write-Host ''
            Write-Host "     ${B}select a model${R}"
            Write-Host "       ${ACCENT}[1]${R}  Jun 12B  ${DIM}- highest quality${R}"
            Write-Host "       ${ACCENT}[2]${R}  Jun E4B  ${DIM}- balanced${R}"
            Write-Host "       ${ACCENT}[3]${R}  Jun E2B  ${DIM}- lightest / CPU-friendly${R}"
            if ($null -ne $vram) {
                $vramNote = ''
                if ($gpus -ge 2) {
                    $vramNote = if ($script:tensorParallel -eq 'on') { " across $gpus GPUs" } else { ' on the largest GPU' }
                }
                Write-Host "       ${DIM}detected ${vram}MB VRAM${vramNote}${R}"
            }
            $ans = Read-Styled "     ${OK}▸${R} choice ${DIM}[Enter = recommended ${rec}]${R} ${ACCENT}›${R} "
            switch ($ans) {
                '1' { $alias = '12b' }
                '2' { $alias = 'e4b' }
                '3' { $alias = 'e2b' }
                ''  { $alias = $rec }
                default { Warn_ 'unrecognized choice, using recommended model'; $alias = $rec }
            }
        } else {
            $alias = $rec
        }
    }
    return Resolve-Model $alias
}

function Ask-TensorParallel {
    if ($env:JUN_TENSOR_PARALLEL) {
        return $(if ($env:JUN_TENSOR_PARALLEL.ToLower() -match '^(on|1|true|yes|y)$') { 'on' } else { 'off' })
    }
    if (-not $interactive -or (Get-GpuCount) -lt 2) { return 'off' }
    $v = Read-Styled "     ${OK}▸${R} use all GPUs for one model? ${DIM}(fits bigger models, but slower per token)${R} ${DIM}[y/N]${R} ${ACCENT}›${R} "
    return $(if ($v -match '^(y|yes)$') { 'on' } else { 'off' })
}

function Configure-Jun {
    $provider = if ($env:JUN_PROVIDER) { $env:JUN_PROVIDER.ToLower() } else { '' }
    if (-not $provider) {
        if ($interactive) {
            Write-Host ''
            Write-Host "     ${B}select an AI provider${R}"
            Write-Host "       ${ACCENT}[1]${R}  Ollama      ${DIM}- local, fully managed${R} ${DIM}(default)${R}"
            Write-Host "       ${ACCENT}[2]${R}  OpenRouter  ${DIM}- cloud API - needs an API key; chats leave this machine${R}"
            Write-Host "       ${ACCENT}[3]${R}  llama.cpp   ${DIM}- local llama-server${R}"
            $ans = Read-Styled "     ${OK}▸${R} choice ${DIM}[Enter = Ollama]${R} ${ACCENT}›${R} "
            $provider = switch ($ans) {
                '2' { 'openrouter' }
                '3' { 'llamacpp' }
                default { 'ollama' }
            }
        } else {
            $provider = 'ollama'
        }
    }
    if ($provider -notin 'ollama', 'openrouter', 'llamacpp') {
        Warn_ "unknown provider '$provider', using Ollama"
        $provider = 'ollama'
    }

    Step 'configure'

    # Asked before the model prompt: splitting across cards changes how much
    # VRAM the recommendation gets to assume.
    $script:tensorParallel = if ($provider -eq 'openrouter') { 'off' } else { Ask-TensorParallel }

    $needsOllama = ($provider -eq 'ollama')
    $needsLlamacpp = $false

    switch ($provider) {
        'ollama' {
            $modelRef = Ask-ModelRef
            Set-EnvKey 'OLLAMA_MODELS_TO_PULL' $modelRef
            Ok "model $modelRef"
        }
        'openrouter' {
            $key = $env:OPENROUTER_API_KEY
            if (-not $key -and $interactive) {
                # Masked input, PS 5.1-compatible; the key is never echoed and
                # never printed in the config summary.
                Write-Host "     ${OK}▸${R} OpenRouter API key ${DIM}(hidden; from openrouter.ai/keys)${R}"
                $sec = Read-Host '       key' -AsSecureString
                $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
                    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
            }
            if (-not $key) { Warn_ 'no API key set - add OPENROUTER_API_KEY to .env before chatting' }

            $orm = $env:OPENROUTER_MODEL
            if (-not $orm -and $interactive) {
                $orm = Read-Styled "     ${OK}▸${R} model id ${DIM}[Enter = openrouter/auto]${R} ${ACCENT}›${R} "
            }
            if (-not $orm) { $orm = 'openrouter/auto' }

            Set-EnvKey 'OPENROUTER_API_KEY' "$key"
            Set-EnvKey 'OPENROUTER_MODEL' $orm
            Ok "model $orm"
        }
        'llamacpp' {
            $url = $env:LLAMACPP_URL
            if (-not $url -and $interactive) {
                $url = Read-Styled "     ${OK}▸${R} llama-server URL ${DIM}[Enter = managed setup]${R} ${ACCENT}›${R} "
            }
            if ($url -and $url -notmatch '^https?://') {
                Warn_ 'not an http(s) URL, using managed setup'
                $url = ''
            }
            if ($url) {
                Set-EnvKey 'LLAMACPP_URL' $url
                Ok "llama-server $url"
            } else {
                $modelRef = Ask-ModelRef
                # llama-server -hf syntax has no hf.co/ prefix.
                $hfRef = $modelRef -replace '^hf\.co/', ''
                Set-EnvKey 'LLAMACPP_MODEL_HF' $hfRef
                Set-EnvKey 'LLAMACPP_URL' 'http://127.0.0.1:8081'
                Set-EnvKey 'LLAMACPP_PORT' '8081'
                $needsLlamacpp = $true
                Ok "model $hfRef"
            }
        }
    }
    Set-EnvKey 'AI_PROVIDER' $provider
    Ok "provider $provider"

    Set-EnvKey 'TENSOR_PARALLEL' $script:tensorParallel
    if ($script:tensorParallel -eq 'on') { Ok 'tensor parallel on' }

    $voice = $env:VOICE
    if ($voice) {
        $voice = if ($voice.ToLower() -match '^(off|0|false|no)$') { 'off' } else { 'on' }
    } elseif ($interactive) {
        $v = Read-Styled "     ${OK}▸${R} enable voice ${DIM}(TTS)${R} ${DIM}[Y/n]${R} ${ACCENT}›${R} "
        $voice = if ($v -match '^(n|no)$') { 'off' } else { 'on' }
    } else {
        $voice = 'on'
    }
    Set-EnvKey 'VOICE' $voice
    Ok "voice $voice"

    # Bare metal runs one sidecar process for both roles, so karaoke here is just
    # a second pip install into the same venv rather than a separate service.
    # It stays on CPU: the Windows venv is built against the CPU torch wheel.
    $karaoke = $env:KARAOKE
    if ($karaoke) {
        $karaoke = if ($karaoke.ToLower() -match '^(off|0|false|no)$') { 'off' } else { 'on' }
    } elseif ($interactive -and $voice -eq 'on') {
        $v = Read-Styled "     ${OK}▸${R} enable karaoke ${DIM}(sing along - adds a few GB)${R} ${DIM}[Y/n]${R} ${ACCENT}›${R} "
        $karaoke = if ($v -match '^(n|no)$') { 'off' } else { 'on' }
    } elseif ($voice -eq 'on') {
        $karaoke = 'on'
    } else {
        $karaoke = 'off'
    }
    Set-EnvKey 'KARAOKE' $karaoke
    Ok "karaoke $karaoke"

    return @{ provider = $provider; voice = $voice; karaoke = $karaoke
              needsOllama = $needsOllama; needsLlamacpp = $needsLlamacpp }
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (($machine, $user, $env:Path) | Where-Object { $_ }) -join ';'
}

# winget (App Installer) is missing on some clean/LTSC/Server images. Bootstrap
# it via the WinGet PowerShell module, which pulls in the real client. Returns
# $true if winget is available afterwards.
function Ensure-Winget {
    if (Get-Command winget -ErrorAction SilentlyContinue) { return $true }
    Note 'winget not found, attempting to bootstrap via WinGet PowerShell module'
    try {
        Install-PackageProvider -Name NuGet -Force | Out-Null
        Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery | Out-Null
        Repair-WinGetPackageManager -AllUsers
    } catch {
        Warn_ ("couldn't bootstrap winget automatically: {0}" -f $_.Exception.Message)
    }
    Refresh-Path
    return [bool](Get-Command winget -ErrorAction SilentlyContinue)
}

# Install the named tools with winget, after warning that these are the ONLY
# machine-wide pieces (each keeps its own uninstaller in Settings > Apps).
function Install-MachineTools([string[]]$missing, [switch]$Optional) {
    if ($missing.Count -eq 0) { return }

    Write-Host ''
    Warn_ ("these tools aren't installed: {0}" -f ($missing -join ', '))
    Note 'they are the only machine-wide installs Jun needs; everything else stays'
    Note 'inside the Jun folder. Each gets a normal uninstaller under Settings > Apps.'

    if (-not (Ensure-Winget)) {
        Fail_ "winget (App Installer) isn't available - install them manually and re-run:"
        foreach ($c in $missing) { Write-Host ("       ${ACCENT}{0,-7}${R} ${DIM}{1}${R}" -f $c, $manualUrls[$c]) }
        if ($Optional) { return } else { exit 1 }
    }

    $proceed = $env:JUN_YES -eq '1'
    if (-not $proceed) {
        if (-not [Environment]::UserInteractive) {
            Note "re-run in an interactive terminal (or set `$env:JUN_YES='1') to install them."
            if ($Optional) { return } else { exit 1 }
        }
        $answer = Read-Styled ("     ${OK}▸${R} install {0} now with winget? ${DIM}[y/N]${R} ${ACCENT}›${R} " -f ($missing -join ' and '))
        $proceed = $answer -match '^(y|yes)$'
    }
    if (-not $proceed) {
        Note 'okay, leaving it to you - install the tools above and re-run this installer.'
        if ($Optional) { return } else { exit 1 }
    }

    foreach ($c in $missing) {
        Step ("install {0}" -f $c)
        winget install -e --id $wingetIds[$c] --accept-source-agreements --accept-package-agreements
        Ok ("{0} installed" -f $c)
    }
    Refresh-Path
}

function Get-UsablePython {
    $candidates = @(
        Get-Command python -ErrorAction SilentlyContinue
        Get-Command python3 -ErrorAction SilentlyContinue
    ) | Where-Object { $_ }

    foreach ($python in $candidates) {
        # Skip the Windows Store alias stub outright: probing it writes to
        # stderr, which $ErrorActionPreference='Stop' turns into a terminating
        # NativeCommandError on PowerShell 5.1. Run the probe through cmd so
        # any other stderr output never reaches PowerShell either.
        if ($python.Source -like '*\WindowsApps\*') { continue }
        cmd /c "`"$($python.Source)`" -c `"import ensurepip, sys, venv; assert sys.version_info >= (3, 9)`" >nul 2>nul"
        if ($LASTEXITCODE -eq 0) { return $python }
    }
    return $null
}

function Install-Php {
    $phpDir = Join-Path (Get-Location) 'runtime\php'
    $phpExe = Join-Path $phpDir 'php.exe'

    # The windows.php.net builds link against the VC++ runtime, which fresh
    # Windows installs often lack (php.exe then dies with a missing
    # VCRUNTIME140.dll dialog). Tiny, standard, machine-wide MS component.
    if (-not (Test-Path (Join-Path $env:SystemRoot 'System32\vcruntime140.dll'))) {
        if (-not (Ensure-Winget)) {
            throw 'The Microsoft Visual C++ 2015-2022 Redistributable (x64) is required for PHP, but winget could not be installed.'
        }
        Step 'install Visual C++ runtime (needed by PHP)'
        winget install -e --id Microsoft.VCRedist.2015+.x64 --accept-source-agreements --accept-package-agreements
    }

    if (Test-Path $phpExe) { return }

    Step 'download portable PHP'
    $releases = Invoke-RestMethod 'https://windows.php.net/downloads/releases/releases.json'
    $branch = ($releases.PSObject.Properties.Name | Sort-Object { [version]$_ } | Select-Object -Last 1)
    $build = $releases.$branch.PSObject.Properties |
        Where-Object { $_.Name -match '^nts-.*-x64$' } | Select-Object -First 1
    if (-not $build) { throw "Couldn't find a 64-bit NTS PHP build in releases.json" }
    $zipUrl = 'https://windows.php.net/downloads/releases/' + $build.Value.zip.path

    $zip = Join-Path $env:TEMP 'jun-php.zip'
    Invoke-WebRequest -Uri $zipUrl -OutFile $zip
    New-Item -ItemType Directory -Force -Path $phpDir | Out-Null
    Expand-Archive -Path $zip -DestinationPath $phpDir -Force
    Remove-Item $zip -ErrorAction SilentlyContinue

    $cacert = Join-Path $phpDir 'cacert.pem'
    try { Invoke-WebRequest -Uri 'https://curl.se/ca/cacert.pem' -OutFile $cacert } catch {
        Warn_ 'could not download cacert.pem; HTTPS from PHP (web fetch tool) may not work'
    }
    $ini = @(
        "extension_dir=`"$phpDir\ext`""
        'extension=curl'
        'extension=mbstring'
        'extension=openssl'
        'extension=pdo_sqlite'
        'extension=sqlite3'
        'post_max_size=512K'
        'upload_max_filesize=1M'
        'memory_limit=128M'
        'expose_php=Off'
        'display_errors=Off'
        'log_errors=On'
    )
    if (Test-Path $cacert) {
        $ini += "curl.cainfo=`"$cacert`""
        $ini += "openssl.cafile=`"$cacert`""
    }
    $ini | Set-Content (Join-Path $phpDir 'php.ini')

    # Capture before piping: Select-Object -First stops the pipeline early,
    # leaving $LASTEXITCODE stale from a previous command.
    $phpVersionOut = cmd /c "`"$phpExe`" -v 2>&1"
    $phpRan = ($LASTEXITCODE -eq 0)
    $phpVersionOut | Select-Object -First 1 | Write-Host
    if (-not $phpRan) {
        Warn_ 'php.exe did not run. If you saw a VCRUNTIME140.dll error, install the'
        Warn_ 'Microsoft Visual C++ 2015-2022 Redistributable (x64) and re-run.'
    } else {
        Ok 'portable PHP ready'
    }
}

function Install-Tts([string]$Karaoke = 'off') {
    $venv = Join-Path (Get-Location) 'runtime\tts-venv'
    $py = Join-Path $venv 'Scripts\python.exe'

    if (-not (Test-Path $py)) {
        $python = Get-UsablePython
        if (-not $python) {
            Install-MachineTools @('python') -Optional
            $python = Get-UsablePython
            if (-not $python) {
                Warn_ 'Python still not found - skipping voice. Re-run install.ps1 after installing it.'
                Set-EnvKey 'VOICE' 'off'
                Set-EnvKey 'KARAOKE' 'off'
                return
            }
        }

        Step 'set up TTS voice engine (a few GB, one-time)'
        & $python.Source -m venv $venv
        & $py -m pip install --upgrade pip
        # CPU torch wheel first so the resolver doesn't pull CUDA builds in as a
        # transitive dep; both voice models hit real-time on CPU.
        & $py -m pip install torch --index-url https://download.pytorch.org/whl/cpu
        & $py -m pip install -r (Join-Path (Get-Location) 'tts\requirements.txt')
        if ($LASTEXITCODE -ne 0) {
            Warn_ 'TTS setup failed - continuing text-only. Re-run install.ps1 to retry.'
            Set-EnvKey 'VOICE' 'off'
            Set-EnvKey 'KARAOKE' 'off'
            return
        }
        Ok 'TTS voice engine ready'
    }

    if ($Karaoke -ne 'on') { return }
    # Bare metal serves both roles from one process, so karaoke is an extra layer
    # on the same venv. Docker splits them into two containers instead, which is
    # where GPU separation lives - this venv is CPU-only.
    # Probe through cmd: a failed import writes a traceback to stderr, which
    # $ErrorActionPreference='Stop' would turn into a terminating error.
    cmd /c "`"$py`" -c `"import demucs`" >nul 2>nul"
    if ($LASTEXITCODE -eq 0) { return }

    Step 'set up karaoke stem separation (a few GB, one-time)'
    & $py -m pip install torchaudio --index-url https://download.pytorch.org/whl/cpu
    & $py -m pip install -r (Join-Path (Get-Location) 'tts\requirements-karaoke.txt')
    if ($LASTEXITCODE -ne 0) {
        Warn_ 'karaoke setup failed - the rest still works. Re-run install.ps1 to retry.'
        Set-EnvKey 'KARAOKE' 'off'
    } else {
        Ok 'karaoke ready'
    }
}

# ══════════════════════════════════════════════════════════════════════════════
function Install-AssetRecovery {
    $python = Get-UsablePython
    if (-not $python) {
        # The user explicitly selected extraction, so Python is required here
        # instead of being treated as an optional voice dependency.
        Install-MachineTools @('python')
        $python = Get-UsablePython
        if (-not $python) {
            throw 'Python 3.9 or newer is required for asset recovery. Re-run install.ps1 after installing it.'
        }
    }

    $venv = Join-Path (Get-Location) 'runtime\asset-recovery-venv'
    $recoveryPython = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path $recoveryPython)) {
        Step 'set up local asset-recovery environment'
        & $python.Source -m venv $venv
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the asset-recovery virtual environment.' }
    }

    Step 'install UnityPy + Pillow'
    & $recoveryPython -m pip install --disable-pip-version-check --quiet UnityPy Pillow
    if ($LASTEXITCODE -ne 0) { throw 'Could not install UnityPy and Pillow for asset recovery.' }

    $recoveryArgs = @('tools/recover_assets.py')
    if ($env:JUN_GAME_DIR) { $recoveryArgs += @('--game', $env:JUN_GAME_DIR) }
    & $recoveryPython @recoveryArgs
    if ($LASTEXITCODE -eq 0) {
        Ok 'assets extracted to webapp/assets (local use only)'
        return
    }

    # A supplied path is deliberate, and non-interactive installs must never
    # wait for input. Only offer the friendly fallback after auto-discovery.
    if ($env:JUN_GAME_DIR -or -not $interactive) {
        Warn_ 'Asset extraction failed. Set JUN_GAME_DIR to the game folder, then re-run with JUN_EXTRACT=1.'
        return
    }

    Warn_ "Couldn't find the game in its usual locations."
    while ($true) {
        $selection = Read-Styled "     ${OK}▸${R} paste the game folder or drag My Dystopian Robot Girlfriend.exe here ${DIM}[Enter = skip]${R} ${ACCENT}›${R} "
        if ([string]::IsNullOrWhiteSpace($selection)) {
            Note 'asset extraction skipped.'
            return
        }

        # Windows terminals wrap drag-and-drop paths in quotes. A file input
        # means its containing folder; a folder input is used as-is.
        $path = $selection.Trim().Trim('"').Trim("'")
        try {
            $item = Get-Item -LiteralPath $path -ErrorAction Stop
        } catch {
            Warn_ "path not found: $path"
            continue
        }
        $gameDir = if ($item.PSIsContainer) { $item.FullName } else { $item.Directory.FullName }
        $dataDir = Join-Path $gameDir 'My Dystopian Robot Girlfriend_Data'
        if (-not (Test-Path -LiteralPath $dataDir -PathType Container)) {
            Warn_ "that location does not contain My Dystopian Robot Girlfriend_Data"
            continue
        }

        & $recoveryPython tools/recover_assets.py --game $gameDir
        if ($LASTEXITCODE -eq 0) {
            Ok 'assets extracted to webapp/assets (local use only)'
            return
        }
        Warn_ 'Asset extraction failed from that location. Try another path or press Enter to skip.'
    }
}

# Main flow
# ══════════════════════════════════════════════════════════════════════════════

Show-Banner
Choose-InstallMode

Step 'check dependencies'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Warn_ 'git not found'
    Install-MachineTools @('git')
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail_ 'git still not on PATH'
    Note 'open a NEW terminal (so PATH refreshes) and run the one-liner again; setup will resume.'
    exit 1
}
Ok 'git found'

if (Test-Path (Join-Path $dir '.git')) {
    Step 'update repository'
    git -C $dir pull --ff-only
    Ok "$dir up to date"
} else {
    Step 'clone repository'
    git clone --depth 1 --branch $ref $repo $dir
    Ok "$repo ($ref)"
}

Set-Location -LiteralPath $dir
if (-not (Test-Path .env)) { Copy-Item .env.example .env }

$cfg = Configure-Jun
$voice = $cfg.voice

$missing = @()
if ($cfg.needsOllama -and -not (Get-Command ollama -ErrorAction SilentlyContinue)) { $missing += 'ollama' }
if ($cfg.needsLlamacpp -and -not (Get-Command llama-server -ErrorAction SilentlyContinue)) { $missing += 'llamacpp' }
Install-MachineTools $missing
if ($cfg.needsOllama -and -not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Fail_ 'ollama still not on PATH'
    Note 'open a NEW terminal (so PATH refreshes) and run the one-liner again; setup will resume.'
    exit 1
}
if ($cfg.needsLlamacpp -and -not (Get-Command llama-server -ErrorAction SilentlyContinue)) {
    Fail_ 'llama-server still not on PATH'
    Note 'open a NEW terminal (so PATH refreshes) and run the one-liner again; setup will resume.'
    exit 1
}

Install-Php
if ($voice -eq 'on') { Install-Tts $cfg.karaoke }

Step 'asset policy'
Warn_ "Jun's Live2D model & textures belong to the creator of"
Warn_ 'My Dystopian Robot Girlfriend. tools/recover_assets.py rebuilds'
Warn_ 'them from YOUR game copy, for personal use only - do NOT'
Warn_ 'republish them (public fork, release, mirror). See NOTICE in LICENSE.'

# Opt-in extraction of the Live2D assets from the user's own game install.
# Never runs unless explicitly requested: answer y here, or JUN_EXTRACT=1
# when non-interactive. Without it the webapp uses placeholder assets.
$extract = $false
switch -Regex ($env:JUN_EXTRACT) {
    '^(1|on|yes|true)$'  { $extract = $true }
    '^(0|off|no|false)$' { $extract = $false }
    default {
        if ($interactive) {
            $e = Read-Styled "     ${OK}▸${R} extract them now from your game install? ${DIM}[y/N]${R} ${ACCENT}›${R} "
            $extract = $e -match '^(y|yes)$'
        }
    }
}
if ($extract) {
    Install-AssetRecovery
} else {
    Note 'skipped - re-run install.ps1 with JUN_EXTRACT=1 anytime to extract.'
}

Write-Host ''
Step 'install summary'
$loc = Get-Location
Note "in this folder (${loc}): webapp, PHP, TTS venv, models, chat data"
$machineWide = 'git'
if ($cfg.needsOllama) { $machineWide += ', Ollama' }
if ($cfg.needsLlamacpp) { $machineWide += ', llama.cpp' }
if ($voice -eq 'on' -or $extract) { $machineWide += ', possibly Python' }
Note "machine-wide (Settings > Apps): ${machineWide}"
Note 'to remove everything later: ./uninstall.ps1'

Write-Host ''
Write-Host "  ${OK}▸${R} ${B}${OK}starting${R} ${DIM}-${R} launching start.ps1"
# Re-launch via the same PowerShell with Bypass so the machine's execution
# policy can't block start.ps1 (this script may have arrived through `iex`).
$psExe = (Get-Process -Id $PID).MainModule.FileName
& $psExe -NoProfile -ExecutionPolicy Bypass -File (Resolve-Path './start.ps1').Path
exit $LASTEXITCODE

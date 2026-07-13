#!/usr/bin/env pwsh
#
# Bootstrap installer for Windows - bare metal, no Docker. Clones Jun OS (if
# not already present), sets up everything it needs, and launches start.ps1.
#
#   irm https://raw.githubusercontent.com/efficiencyx/Jun/main/install.ps1 | iex
#
# What lands where (uninstallability is the design goal - see uninstall.ps1):
#   - The Jun folder itself: webapp, a portable PHP under runtime\php, the
#     TTS Python venv under runtime\tts-venv, model weights under
#     runtime\ollama-models, chat state under runtime\state. Deleting the
#     folder removes all of it.
#   - Machine-wide (via winget, each with its own uninstaller in
#     Settings > Apps): git, Ollama, and - only if voice is enabled and no
#     Python 3 exists - Python. The installer warns before touching these.
#
# In a terminal it asks which model to pull (auto-detecting a default from
# your VRAM) and whether to enable voice; piped or with $env:JUN_YES='1' it
# stays one-command (recommended model + voice on). Override non-interactively:
# $env:JUN_MODEL='12b|e4b|e2b|<full-ref>', $env:VOICE='on|off'.
#
# Overrides: $env:JUN_REPO, $env:JUN_DIR, $env:JUN_REF.
# Set $env:JUN_YES='1' to skip prompts (assume yes).
# Prefer to read before you run? Sensible - open the file first, then clone
# the repo and run ./start.ps1 yourself.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = if ($env:JUN_REPO) { $env:JUN_REPO } else { 'https://github.com/efficiencyx/Jun.git' }
$dir  = if ($env:JUN_DIR)  { $env:JUN_DIR }  else { 'Jun' }
$ref  = if ($env:JUN_REF)  { $env:JUN_REF }  else { 'main' }

# winget package ids for the machine-wide tools we depend on.
$wingetIds = @{ git = 'Git.Git'; ollama = 'Ollama.Ollama'; python = 'Python.Python.3.11' }
$manualUrls = @{
    git    = 'https://git-scm.com/download/win'
    ollama = 'https://ollama.com/download/windows'
    python = 'https://www.python.org/downloads/windows/'
}

# Short aliases the menu and $env:JUN_MODEL accept; anything else is verbatim.
$models = @{
    '12b' = 'hf.co/efficiencyx/Jun-Lora-v2-GGUF:Q4_K_M'
    'e4b' = 'hf.co/efficiencyx/Jun-LoRA-V3-E4B-GGUF:Q4_K_M'
    'e2b' = 'hf.co/efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q4_K_M'
}

function Resolve-Model([string]$a) {
    switch -Regex ($a.ToLower()) {
        '^(12b|jun|best)$'     { return $models['12b'] }
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
    if ($mb -ge 15500) { return 'hf.co/efficiencyx/Jun-Lora-v2-GGUF:Q6_K' }
    if ($mb -ge 11500) { return 'hf.co/efficiencyx/Jun-LoRA-V3-E4B-GGUF:Q8_0' }
    if ($mb -ge 9500) { return 'hf.co/efficiencyx/Jun-LoRA-V3-E4B-GGUF:Q6_K' }
    if ($mb -ge 7500) { return $models['e4b'] }
    if ($mb -ge 5500) { return 'hf.co/efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q6_K' }
    return $models['e2b']
}

function Set-EnvKey([string]$key, [string]$val) {
    $lines = @()
    if (Test-Path .env) { $lines = Get-Content .env | Where-Object { $_ -notmatch "^$key=" } }
    $lines += "$key=$val"
    Set-Content -Path .env -Value $lines
}

$interactive = [Environment]::UserInteractive -and ($env:JUN_YES -ne '1')

# Ask which model + whether voice, then persist both into .env. Non-interactive
# (JUN_YES, per-field env override, or no console) keeps the one-command flow.
function Configure-Jun {
    $vram = Get-VramMb
    $rec  = if ($null -ne $vram) { Recommend-Alias $vram } else { $models['e2b'] }

    $alias = $env:JUN_MODEL
    if (-not $alias) {
        if ($interactive) {
            Write-Host ""
            Write-Host "Which model should Jun run?"
            Write-Host "  1) Jun 12B  - highest quality"
            Write-Host "  2) Jun E4B  - balanced"
            Write-Host "  3) Jun E2B  - lightest / CPU-friendly"
            if ($null -ne $vram) { Write-Host "  (detected ${vram}MB VRAM)" }
            $ans = Read-Host "Choice [Enter = recommended $rec]"
            switch ($ans) {
                '1' { $alias = '12b' }
                '2' { $alias = 'e4b' }
                '3' { $alias = 'e2b' }
                ''  { $alias = $rec }
                default { Write-Host "Unrecognized choice, using recommended model."; $alias = $rec }
            }
        } else {
            $alias = $rec
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

    $modelRef = Resolve-Model $alias
    Set-EnvKey 'OLLAMA_MODELS_TO_PULL' "$modelRef,nomic-embed-text"
    Set-EnvKey 'VOICE' $voice
    Write-Host "==> Config: model=$modelRef, voice=$voice"
    return $voice
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
    Write-Host "==> winget not found, attempting to bootstrap it via the WinGet PowerShell module"
    try {
        Install-PackageProvider -Name NuGet -Force | Out-Null
        Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery | Out-Null
        Repair-WinGetPackageManager -AllUsers
    } catch {
        Write-Warning ("Couldn't bootstrap winget automatically: {0}" -f $_.Exception.Message)
    }
    Refresh-Path
    return [bool](Get-Command winget -ErrorAction SilentlyContinue)
}

# Install the named tools with winget, after warning that these are the ONLY
# machine-wide pieces (each keeps its own uninstaller in Settings > Apps).
function Install-MachineTools([string[]]$missing, [switch]$Optional) {
    if ($missing.Count -eq 0) { return }

    Write-Host ""
    Write-Warning ("These tools aren't installed: {0}" -f ($missing -join ', '))
    Write-Host "They are the only machine-wide installs Jun needs; everything else stays"
    Write-Host "inside the Jun folder. Each gets a normal uninstaller under Settings > Apps."

    if (-not (Ensure-Winget)) {
        Write-Host "winget (App Installer) isn't available, so install them manually and re-run:"
        foreach ($c in $missing) { Write-Host ("  {0,-7} {1}" -f $c, $manualUrls[$c]) }
        if ($Optional) { return } else { exit 1 }
    }

    $proceed = $env:JUN_YES -eq '1'
    if (-not $proceed) {
        if (-not [Environment]::UserInteractive) {
            Write-Host "Re-run in an interactive terminal (or set `$env:JUN_YES='1') to install them."
            if ($Optional) { return } else { exit 1 }
        }
        $answer = Read-Host ("Install {0} now with winget? [y/N]" -f ($missing -join ' and '))
        $proceed = $answer -match '^(y|yes)$'
    }
    if (-not $proceed) {
        Write-Host "Okay, leaving it to you. Install the tools above and re-run this installer."
        if ($Optional) { return } else { exit 1 }
    }

    foreach ($c in $missing) {
        Write-Host ("==> Installing {0} via winget" -f $wingetIds[$c])
        winget install -e --id $wingetIds[$c] --accept-source-agreements --accept-package-agreements
    }
    Refresh-Path
}

# ── Portable PHP into runtime\php (no machine-wide install, no PATH edits) ──
function Install-Php {
    $phpDir = Join-Path (Get-Location) 'runtime\php'
    $phpExe = Join-Path $phpDir 'php.exe'

    # The windows.php.net builds link against the VC++ runtime, which fresh
    # Windows installs often lack (php.exe then dies with a missing
    # VCRUNTIME140.dll dialog). Tiny, standard, machine-wide MS component.
    if (-not (Test-Path (Join-Path $env:SystemRoot 'System32\vcruntime140.dll'))) {
        Write-Host '==> Installing the Microsoft Visual C++ runtime (needed by PHP)'
        winget install -e --id Microsoft.VCRedist.2015+.x64 --accept-source-agreements --accept-package-agreements
    }

    if (Test-Path $phpExe) { return }

    Write-Host '==> Downloading portable PHP into runtime\php'
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

    # Minimal php.ini: the bundled extensions the API needs + the same
    # security/size tuning the Docker image used.
    $cacert = Join-Path $phpDir 'cacert.pem'
    try { Invoke-WebRequest -Uri 'https://curl.se/ca/cacert.pem' -OutFile $cacert } catch {
        Write-Warning 'Could not download cacert.pem; HTTPS from PHP (web fetch tool) may not work.'
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

    cmd /c "`"$phpExe`" -v 2>&1" | Select-Object -First 1 | Write-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'php.exe did not run. If you saw a VCRUNTIME140.dll error, install the Microsoft Visual C++ 2015-2022 Redistributable (x64) and re-run.'
    }
}

# ── TTS venv into runtime\tts-venv (only when voice is on) ──────────────────
function Install-Tts {
    $venv = Join-Path (Get-Location) 'runtime\tts-venv'
    $py = Join-Path $venv 'Scripts\python.exe'
    if (Test-Path $py) { return }

    $python = (Get-Command python -ErrorAction SilentlyContinue), (Get-Command python3 -ErrorAction SilentlyContinue) |
        Where-Object { $_ } | Select-Object -First 1
    # The Microsoft Store stub named python.exe exits non-zero; verify it runs.
    if ($python) {
        & $python.Source -c 'import sys; assert sys.version_info >= (3, 9)' 2>$null
        if ($LASTEXITCODE -ne 0) { $python = $null }
    }
    if (-not $python) {
        Install-MachineTools @('python') -Optional
        $python = Get-Command python -ErrorAction SilentlyContinue
        if (-not $python) {
            Write-Warning 'Python still not found - skipping voice. Re-run install.ps1 after installing it.'
            Set-EnvKey 'VOICE' 'off'
            return
        }
    }

    Write-Host '==> Setting up the TTS voice engine in runtime\tts-venv (a few GB, one-time)'
    & $python.Source -m venv $venv
    & $py -m pip install --upgrade pip
    # CPU torch wheel first so the resolver doesn't pull CUDA builds in as a
    # transitive dep; both voice models hit real-time on CPU.
    & $py -m pip install torch --index-url https://download.pytorch.org/whl/cpu
    & $py -m pip install -r (Join-Path (Get-Location) 'tts\requirements.txt')
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'TTS setup failed - continuing text-only. Re-run install.ps1 to retry.'
        Set-EnvKey 'VOICE' 'off'
    }
}

# ── main ─────────────────────────────────────────────────────────────────────
$missing = @()
foreach ($c in 'git', 'ollama') {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { $missing += $c }
}
Install-MachineTools $missing
if (-not (Get-Command git -ErrorAction SilentlyContinue) -or -not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Error 'git/ollama still not on PATH. Open a NEW terminal (so PATH refreshes) and run the one-liner again; setup will resume.'
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

$voice = Configure-Jun
Install-Php
if ($voice -eq 'on') { Install-Tts }

Write-Host ""
Write-Host "Asset policy:" -ForegroundColor Yellow
Write-Host "  Jun's Live2D model & textures belong to the creator of My Dystopian" -ForegroundColor Yellow
Write-Host "  Robot Girlfriend. tools/recover_assets.py rebuilds them from YOUR game" -ForegroundColor Yellow
Write-Host "  copy, for personal use only - do NOT republish them (public fork," -ForegroundColor Yellow
Write-Host "  release, mirror). See the NOTICE in LICENSE." -ForegroundColor Yellow

# Opt-in extraction from the user's own game install. Never runs unless
# explicitly requested: answer y here, or set JUN_EXTRACT=1 non-interactively.
# Without it the webapp uses placeholder assets.
$extract = $false
switch -Regex ($env:JUN_EXTRACT) {
    '^(1|on|yes|true)$'  { $extract = $true }
    '^(0|off|no|false)$' { $extract = $false }
    default {
        if ($interactive) {
            $e = Read-Host "Extract them now from your game install? [y/N]"
            $extract = $e -match '^(y|yes)$'
        }
    }
}
if ($extract) {
    $python = (Get-Command python -ErrorAction SilentlyContinue), (Get-Command python3 -ErrorAction SilentlyContinue) |
        Where-Object { $_ } | Select-Object -First 1
    if ($python) {
        & $python.Source -m pip install --user --quiet UnityPy Pillow
        & $python.Source tools/recover_assets.py
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'Extraction failed - run "python tools/recover_assets.py --game DIR" later.'
        }
    } else {
        Write-Warning 'Python not found - install it and run "python tools/recover_assets.py" later.'
    }
} else {
    Write-Host '  Skipped - run "python tools/recover_assets.py" anytime to extract.'
}

Write-Host ""
Write-Host "Install summary:"
Write-Host "  In this folder ($(Get-Location)): webapp, PHP, TTS venv, models, chat data."
Write-Host "  Machine-wide (Settings > Apps):   git, Ollama$(if ($voice -eq 'on') { ', possibly Python' })."
Write-Host "  To remove everything later:       ./uninstall.ps1"

Write-Host "==> Starting"
# Re-launch via the same PowerShell with Bypass so the machine's execution
# policy can't block start.ps1 (this script may have arrived through `iex`).
$psExe = (Get-Process -Id $PID).MainModule.FileName
& $psExe -NoProfile -ExecutionPolicy Bypass -File (Resolve-Path './start.ps1').Path
exit $LASTEXITCODE

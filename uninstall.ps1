#
# Uninstaller for the bare-metal Windows install. Everything Jun
# created lives either in this folder or as a normal app under
# Settings > Apps, so removal is:
#   1. stop the running processes (start.ps1 stop)
#   2. optionally uninstall Ollama / llama.cpp (machine-wide apps)
#   3. take Jun's local certificate authority back out of your
#      Windows trust store, if start.ps1 put it there
#   4. delete this folder (webapp, PHP, TTS venv, model weights,
#      chat data)
#
# git (and Python, if voice or asset recovery installed it) are
# left alone. They are general-purpose tools you may use
# elsewhere. Remove them yourself from Settings > Apps if you
# want.
#
#   ./uninstall.ps1              # interactive
#   ./uninstall.ps1 -Yes         # no prompts
#     Stops services, removes llama.cpp and Ollama if present
#     (including Ollama's %USERPROFILE%\.ollama model store),
#     then deletes this folder.

[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# JunOS.exe opens this in its own window, which closes the moment
# the script ends. Keep the error on screen.
trap {
    Write-Host ''
    Write-Host "Uninstall stopped: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Whatever is left is still in $root. Close anything running from it (Task Manager: caddy, php, python, llama-server) and run uninstall.ps1 again, or delete the folder."
    if (-not $Yes) { Read-Host 'Press Enter to close' | Out-Null }
    exit 1
}

function Confirm-Step([string]$question) {
    if ($Yes) { return $true }
    return (Read-Host "$question [y/N]") -match '^(y|yes)$'
}

Write-Host "This removes Jun from: $root"
Write-Host "Chat history, settings and downloaded models in that folder will be deleted."
if (-not (Confirm-Step 'Continue?')) { Write-Host 'Aborted, nothing touched.'; exit 0 }

$start = Join-Path $root 'start.ps1'
if (Test-Path $start) {
    & $start stop
}

# The model servers are the machine-wide pieces Jun really
# installed for itself (which one depends on the provider chosen
# at install time).
if (Get-Command llama-server -ErrorAction SilentlyContinue) {
    if (Confirm-Step 'Uninstall llama.cpp too (machine-wide app)?') {
        Get-Process 'llama-server*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        winget uninstall -e --id ggml.llamacpp
        # Models Jun downloaded live in runtime\llama-cache (deleted
        # below).
    }
}

if (Get-Command ollama -ErrorAction SilentlyContinue) {
    if (Confirm-Step 'Uninstall Ollama too (machine-wide app)?') {
        Get-Process 'ollama*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        # install.ps1 runs OllamaSetup.exe directly, so the Inno
        # uninstaller sits next to ollama.exe. winget is only for an
        # Ollama that came from somewhere else.
        $unins = Join-Path (Split-Path -Parent (Get-Command ollama).Source) 'unins000.exe'
        if (Test-Path $unins) {
            Start-Process $unins -ArgumentList '/VERYSILENT', '/NORESTART' -Wait
        } else {
            winget uninstall -e --id Ollama.Ollama
        }
        # Models pulled by Jun live in runtime\ollama-models (deleted
        # below), but a pre-existing / self-started Ollama keeps its own
        # store:
        $store = Join-Path $env:USERPROFILE '.ollama'
        if (Test-Path $store) {
            $gb = [math]::Round((Get-ChildItem $store -Recurse -File -ErrorAction SilentlyContinue |
                Measure-Object Length -Sum).Sum / 1GB, 1)
            if (Confirm-Step "Also delete $store (~${gb} GB of models)?") {
                Remove-Item $store -Recurse -Force
            }
        }
    }
}

# runtime\caddy\tls\trusted holds the thumbprint start.ps1 added
# to the current user's Root store. Windows asks to confirm the
# removal.
$trustMark = Join-Path $root 'runtime\caddy\tls\trusted'
if (Test-Path -LiteralPath $trustMark) {
    $thumb = (Get-Content -LiteralPath $trustMark -Raw).Trim()
    if ($thumb -and (Confirm-Step "Remove Jun's local certificate authority from your trust store?")) {
        $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
        $store.Open('ReadWrite')
        try {
            foreach ($c in $store.Certificates.Find('FindByThumbprint', $thumb, $false)) { $store.Remove($c) }
            Write-Host 'Removed the local certificate authority.'
        } catch {
            Write-Host "Could not remove it ($($_.Exception.Message)). Remove ""Jun OS local CA"" from certmgr.msc > Trusted Root Certification Authorities."
        } finally {
            $store.Close()
        }
    }
}

# Only shortcuts that point into this folder. Another install may
# own a "Jun OS" shortcut of its own.
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    if (-not $folder) { continue }
    $path = Join-Path $folder 'Jun OS.lnk'
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $lnk = $shell.CreateShortcut($path)
    if ($lnk.WorkingDirectory -ieq $root -or $lnk.TargetPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $path -Force
        Write-Host "Removed shortcut $path"
    }
}

# JunOS.exe can still be running if it was opened again after the
# uninstall started. It would keep the folder from being deleted.
Get-Process JunOS -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force -ErrorAction SilentlyContinue

# From outside the folder, since this script lives inside it.
Set-Location $env:USERPROFILE
# Windows releases a stopped process's files a moment after it exits.
for ($try = 1; ; $try++) {
    try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop; break }
    catch { if ($try -ge 5) { throw } }
    Start-Sleep -Seconds 2
}
Write-Host "Removed $root. Jun is uninstalled."
Write-Host 'Left in place: git and any Python installed for voice or asset recovery - remove via Settings > Apps if unwanted.'

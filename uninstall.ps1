#!/usr/bin/env pwsh
#
# Uninstaller for the bare-metal Windows install. Everything Jun created
# lives either in this folder or as a normal winget app, so removal is:
#   1. stop the running processes (start.ps1 stop)
#   2. optionally uninstall Ollama / llama.cpp (machine-wide, installed via winget)
#   3. delete this folder (webapp, PHP, TTS venv, model weights, chat data)
#
# git (and Python, if voice setup installed it) are left alone - they're
# general-purpose tools you may use elsewhere. Remove them yourself from
# Settings > Apps if you want.
#
#   ./uninstall.ps1              # interactive
#   ./uninstall.ps1 -Yes         # no prompts: stop, remove Ollama, delete folder

[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Confirm-Step([string]$question) {
    if ($Yes) { return $true }
    return (Read-Host "$question [y/N]") -match '^(y|yes)$'
}

Write-Host "This removes Jun from: $root"
Write-Host "Chat history, settings and downloaded models in that folder will be deleted."
if (-not (Confirm-Step 'Continue?')) { Write-Host 'Aborted, nothing touched.'; exit 0 }

# 1. Stop everything we started.
$start = Join-Path $root 'start.ps1'
if (Test-Path $start) {
    & $start stop
}

# 2. The model servers are the machine-wide pieces Jun really installed for
#    itself (which one depends on the provider chosen at install time).
if (Get-Command llama-server -ErrorAction SilentlyContinue) {
    if (Confirm-Step 'Uninstall llama.cpp too (machine-wide app)?') {
        Get-Process 'llama-server*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        winget uninstall -e --id ggml.llamacpp
        # Models Jun downloaded live in runtime\llama-cache (deleted below).
    }
}

if (Get-Command ollama -ErrorAction SilentlyContinue) {
    if (Confirm-Step 'Uninstall Ollama too (machine-wide app)?') {
        Get-Process 'ollama*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        winget uninstall -e --id Ollama.Ollama
        # Models pulled by Jun live in runtime\ollama-models (deleted below),
        # but a pre-existing / self-started Ollama keeps its own store:
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

# 3. Delete the folder itself (from outside it, since this script lives inside).
Set-Location $env:USERPROFILE
Remove-Item -LiteralPath $root -Recurse -Force
Write-Host "Removed $root. Jun is uninstalled."
Write-Host 'Left in place: git (and Python, if installed) - remove via Settings > Apps if unwanted.'

#requires -Version 5.1

<#
    Compiles installer-gui.ps1 into JunSetup.exe.

    Windows only, and it has to be Windows PowerShell 5.1 or pwsh on Windows:
    ps2exe emits a .NET Framework WPF binary and there is no cross compile.
    Run it from a checkout, the exe still needs the repo around it.
#>

[CmdletBinding()]
param(
    [string]$OutputPath,
    [string]$IconPath,
    [string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'JunSetup.exe can only be built on Windows.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'installer-gui.ps1'
if (-not (Test-Path -LiteralPath $source)) { throw "installer-gui.ps1 not found at $source" }

if (-not $OutputPath) { $OutputPath = Join-Path $repoRoot 'dist\JunSetup.exe' }
$outDir = Split-Path -Parent $OutputPath
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

if (-not (Get-Module -ListAvailable -Name ps2exe)) {
    Write-Host 'installing ps2exe from the PSGallery...'
    Install-Module ps2exe -Scope CurrentUser -Force -AllowClobber
}
Import-Module ps2exe

$ps2exeArgs = @{
    inputFile   = $source
    outputFile  = $OutputPath
    # noConsole hides the console window, STA is what WPF needs and what keeps
    # installer-gui.ps1 out of its self-restart branch (which a compiled build
    # can't take). x64 also matters: it puts powershell.exe under System32
    # where the installer looks for it.
    noConsole   = $true
    STA         = $true
    x64         = $true
    title       = 'Jun OS Setup'
    product     = 'Jun OS'
    description = 'Graphical installer for Jun OS'
    version     = $Version
    # UAC comes from install.ps1 itself where it's actually needed. asking for
    # admin up front would run the whole GUI elevated and drop every file it
    # touches under the admin profile.
    requireAdmin = $false
}
if ($IconPath) { $ps2exeArgs.iconFile = (Resolve-Path -LiteralPath $IconPath).Path }

Invoke-PS2EXE @ps2exeArgs

if (-not (Test-Path -LiteralPath $OutputPath)) { throw 'ps2exe reported success but produced no file.' }
Write-Host "built $OutputPath"
Write-Host 'ship it next to install.ps1 - the exe shells out to that script, it does not contain it.'

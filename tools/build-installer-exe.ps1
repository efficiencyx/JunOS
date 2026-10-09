#requires -Version 5.1

<#
compiles installer-gui.ps1 into JunSetup.exe (JunSetup-<tag>.exe
on a release, pinned to that tag with -PinRef/-PinSha).

Windows only, and it has to be Windows PowerShell 5.1 or pwsh
on Windows. ps2exe spits out a .NET Framework WPF binary and
there's no cross compile. build from a checkout. the EXE embeds
install.ps1 and runs on its own, install.ps1 then clones the
repo itself.
#>

[CmdletBinding()]
param(
    [string]$OutputPath,
    [string]$IconPath,
    [string]$Version = '1.0.0',
    # a release build pins the exe to one tag and the commit it
    # pointed at. install.ps1 then refuses anything else.
    [string]$PinRef,
    [string]$PinSha
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

$installScript = Join-Path $repoRoot 'install.ps1'
if (-not (Test-Path -LiteralPath $installScript)) { throw "install.ps1 not found at $installScript" }

# install.ps1 goes in as base64 on one line. it's the only repo
# file the exe needs (install.ps1 git clones the rest itself),
# so this is what makes the build standalone. UTF8 without a BOM,
# powershell -File chokes on a stray one.
$payload = [Convert]::ToBase64String([IO.File]::ReadAllBytes($installScript))
$lines = [IO.File]::ReadAllLines($source)
$marker = ($lines | Select-String -SimpleMatch 'JUN_EMBEDDED_INSTALLER' | Select-Object -First 1)
if (-not $marker) { throw 'installer-gui.ps1 lost its JUN_EMBEDDED_INSTALLER marker - nothing to embed into.' }
$lines[$marker.LineNumber - 1] = "`$script:EmbeddedInstaller = '$payload' # JUN_EMBEDDED_INSTALLER"

if ($PinRef -or $PinSha) {
    # both land inside single quotes in the staged script, so the
    # patterns are the whole injection check. keep them strict.
    if ($PinRef -notmatch '^[A-Za-z0-9._-]+$') { throw "PinRef '$PinRef' isn't a plain tag name." }
    if ($PinSha -notmatch '^[0-9a-f]{40}$') { throw "PinSha '$PinSha' isn't a full 40 character commit hash." }
    foreach ($pin in @(@('JUN_PINNED_REF', 'PinnedRef', $PinRef), @('JUN_PINNED_SHA', 'PinnedSha', $PinSha))) {
        $at = ($lines | Select-String -SimpleMatch $pin[0] | Select-Object -First 1)
        if (-not $at) { throw "installer-gui.ps1 lost its $($pin[0]) marker - the exe would not be pinned." }
        $lines[$at.LineNumber - 1] = "`$script:$($pin[1]) = '$($pin[2])' # $($pin[0])"
    }
}

$staged = Join-Path ([IO.Path]::GetTempPath()) 'jun-installer-gui-staged.ps1'
[IO.File]::WriteAllLines($staged, $lines, [Text.UTF8Encoding]::new($false))

if (-not (Get-Module -ListAvailable -Name ps2exe)) {
    Write-Host 'installing ps2exe from the PSGallery...'
    Install-Module ps2exe -Scope CurrentUser -Force -AllowClobber
}
Import-Module ps2exe

$ps2exeArgs = @{
    inputFile   = $staged
    outputFile  = $OutputPath
    # noConsole hides the console window. STA (single-threaded
    # apartment, the COM threading mode WPF needs) is also what
    # keeps installer-gui.ps1 out of its self-restart branch, which
    # a compiled build can't take. x64 matters too, it puts
    # powershell.exe under System32 where the installer looks for it.
    noConsole   = $true
    STA         = $true
    x64         = $true
    title       = 'Jun OS Setup'
    product     = 'Jun OS'
    description = 'Graphical installer for Jun OS'
    version     = $Version
    # UAC comes from install.ps1 itself where it's actually needed.
    # asking for admin up front would run the whole GUI elevated and
    # drop every file it touches under the admin profile.
    requireAdmin = $false
}
if ($IconPath) { $ps2exeArgs.iconFile = (Resolve-Path -LiteralPath $IconPath).Path }

try {
    Invoke-PS2EXE @ps2exeArgs
} finally {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $OutputPath)) { throw 'ps2exe reported success but produced no file.' }
Write-Host "built $OutputPath ($([int]((Get-Item $OutputPath).Length / 1KB)) KB)"
Write-Host 'standalone: ship this file on its own, it carries install.ps1 and clones the repo itself.'
if ($PinRef) { Write-Host "pinned: installs $PinRef ($PinSha) and nothing else." }

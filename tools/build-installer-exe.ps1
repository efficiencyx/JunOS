#requires -Version 5.1

<#
compiles installer-gui.ps1 into JunSetup.exe (JunSetup-<tag>.exe
on a release, pinned to that tag with -PinRef/-PinSha). with
-Manager it compiles jun-manager.ps1 into JunOS.exe instead, the
start/stop/update window the installer drops in her folder.

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
    [string]$PinSha,
    [switch]$Manager,
    # a built JunOS.exe to carry inside JunSetup. build -Manager
    # first, then point this at its output.
    [string]$EmbedManager
)

$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'JunSetup.exe can only be built on Windows.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot $(if ($Manager) { 'jun-manager.ps1' } else { 'installer-gui.ps1' })
if (-not (Test-Path -LiteralPath $source)) { throw "$(Split-Path -Leaf $source) not found at $source" }
if ($Manager -and ($PinRef -or $PinSha)) { throw 'JunOS.exe is not pinned, it runs whatever code sits next to it.' }

if (-not $OutputPath) { $OutputPath = Join-Path $repoRoot $(if ($Manager) { 'dist\JunOS.exe' } else { 'dist\JunSetup.exe' }) }
$outDir = Split-Path -Parent $OutputPath
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$lines = [IO.File]::ReadAllLines($source)
if (-not $Manager) {
    $installScript = Join-Path $repoRoot 'install.ps1'
    if (-not (Test-Path -LiteralPath $installScript)) { throw "install.ps1 not found at $installScript" }

    # install.ps1 goes in as base64 on one line. it's the only repo
    # file the exe needs (install.ps1 git clones the rest itself),
    # so this is what makes the build standalone. UTF8 without a BOM,
    # powershell -File chokes on a stray one.
    $payload = [Convert]::ToBase64String([IO.File]::ReadAllBytes($installScript))
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

    if ($EmbedManager) {
        $managerPayload = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $EmbedManager).Path))
        $at = ($lines | Select-String -SimpleMatch 'JUN_EMBEDDED_MANAGER' | Select-Object -First 1)
        if (-not $at) { throw 'installer-gui.ps1 lost its JUN_EMBEDDED_MANAGER marker - JunOS.exe would not be inside.' }
        $lines[$at.LineNumber - 1] = "`$script:EmbeddedManager = '$managerPayload' # JUN_EMBEDDED_MANAGER"
    }
}

$staged = Join-Path ([IO.Path]::GetTempPath()) "jun-$([IO.Path]::GetFileNameWithoutExtension($source))-staged.ps1"
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
    title       = $(if ($Manager) { 'Jun OS' } else { 'Jun OS Setup' })
    product     = 'Jun OS'
    description = $(if ($Manager) { 'Start, stop and update Jun OS' } else { 'Graphical installer for Jun OS' })
    version     = $Version
    # UAC comes from install.ps1 itself where it's actually needed.
    # asking for admin up front would run the whole GUI elevated and
    # drop every file it touches under the admin profile.
    requireAdmin = $false
}

# ps2exe wants an .ico and the repo only has PNGs. an .ico can
# just wrap a PNG (vista+ reads that fine), so scale the app icon
# to 256 and glue the 22 byte header on. 256 goes in as 0 in the
# header, the format has one byte for each side.
if (-not $IconPath) { $IconPath = Join-Path $repoRoot 'webapp\icon-512.png' }
$iconTemp = $null
if ($IconPath -match '\.png$') {
    Add-Type -AssemblyName System.Drawing
    $src = [Drawing.Image]::FromFile((Resolve-Path -LiteralPath $IconPath).Path)
    $bmp = [Drawing.Bitmap]::new(256, 256)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, 256, 256)
    $g.Dispose(); $src.Dispose()
    $png = [IO.MemoryStream]::new()
    $bmp.Save($png, [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $pngBytes = $png.ToArray()
    $ico = [IO.MemoryStream]::new()
    $w = [IO.BinaryWriter]::new($ico)
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
    $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$pngBytes.Length); $w.Write([uint32]22)
    $w.Write($pngBytes)
    $w.Flush()
    $iconTemp = Join-Path ([IO.Path]::GetTempPath()) 'jun-os-icon.ico'
    [IO.File]::WriteAllBytes($iconTemp, $ico.ToArray())
    $IconPath = $iconTemp
}
$ps2exeArgs.iconFile = (Resolve-Path -LiteralPath $IconPath).Path

try {
    Invoke-PS2EXE @ps2exeArgs
} finally {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    if ($iconTemp) { Remove-Item -LiteralPath $iconTemp -Force -ErrorAction SilentlyContinue }
}

if (-not (Test-Path -LiteralPath $OutputPath)) { throw 'ps2exe reported success but produced no file.' }
Write-Host "built $OutputPath ($([int]((Get-Item $OutputPath).Length / 1KB)) KB)"
if (-not $Manager) { Write-Host 'standalone: ship this file on its own, it carries install.ps1 and clones the repo itself.' }
if ($PinRef) { Write-Host "pinned: installs $PinRef ($PinSha) and nothing else." }

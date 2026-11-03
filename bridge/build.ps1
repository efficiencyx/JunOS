# Builds JunBridge.dll against the assemblies MelonLoader generates
# from your own copy of the game. Run the game once with MelonLoader
# installed first, those Il2CppAssemblies only exist after that.
param(
    [Parameter(Mandatory = $true)][string]$GamePath,
    [string]$Configuration = 'Release'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $GamePath 'MelonLoader\Il2CppAssemblies'))) {
    throw "no MelonLoader\Il2CppAssemblies under $GamePath. install MelonLoader and start the game once"
}
dotnet build (Join-Path $PSScriptRoot 'JunBridge.csproj') -c $Configuration "-p:GamePath=$GamePath"
if ($LASTEXITCODE -ne 0) { throw 'JunBridge build failed' }
Get-FileHash (Join-Path $PSScriptRoot "bin\$Configuration\net6.0\JunBridge.dll") -Algorithm SHA256
Write-Host 'LinuxFix builds on Linux with bridge/LinuxFix/build.sh; release CI builds it automatically.'

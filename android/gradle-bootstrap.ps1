$ErrorActionPreference = "Stop"
$version = "8.11.1"
$expected = "f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6"
$cacheRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "JunOS\gradle"
$archive = Join-Path $cacheRoot "gradle-$version-bin.zip"
$install = Join-Path $cacheRoot "gradle-$version"
$marker = Join-Path $install ".junos-verified"

if (-not (Test-Path -LiteralPath $marker)) {
    New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
    $validArchive = (Test-Path -LiteralPath $archive) -and
        ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -eq $expected)
    if (-not $validArchive) {
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
        Invoke-WebRequest -Uri "https://services.gradle.org/distributions/gradle-$version-bin.zip" -OutFile $archive
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Remove-Item -LiteralPath $archive
        throw "Gradle distribution checksum mismatch"
    }
    if (Test-Path -LiteralPath $install) { Remove-Item -Recurse -LiteralPath $install }
    Expand-Archive -LiteralPath $archive -DestinationPath $cacheRoot -Force
    New-Item -ItemType File -Force -Path $marker | Out-Null
}

& (Join-Path $install "bin\gradle.bat") @args
exit $LASTEXITCODE

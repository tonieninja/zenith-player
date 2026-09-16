# One NSIS, one MSI, one portable zip per Windows arch (x64 + x86). No language-split MSIs.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

if (-not $env:ZENITH_SKIP_CODESIGN -and -not $env:ZENITH_CODESIGN_PFX -and -not $env:ZENITH_CODESIGN_THUMBPRINT) {
  & (Join-Path $PSScriptRoot 'gen-dev-codesign-cert.ps1')
}

$version = (Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
$outDir = Join-Path $root 'dist-artifacts\windows'
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$arches = @(
  @{ Triple = 'x86_64-pc-windows-msvc'; Tag = 'x64' },
  @{ Triple = 'i686-pc-windows-msvc'; Tag = 'x86' }
)

function Copy-Legal([string]$DestDir) {
  Copy-Item (Join-Path $root 'DISCLAIMER.md') (Join-Path $DestDir 'DISCLAIMER.md') -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $root 'LICENSE') (Join-Path $DestDir 'LICENSE') -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $root 'NOTICE.md') (Join-Path $DestDir 'NOTICE.md') -ErrorAction SilentlyContinue
}

foreach ($arch in $arches) {
  $triple = $arch.Triple
  $tag = $arch.Tag
  Write-Host "== rustup target $triple =="
  rustup target add $triple
  if ($LASTEXITCODE -ne 0) { throw "rustup target add failed: $triple" }

  Write-Host "== tauri build $triple =="
  pnpm tauri build --target $triple
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed: $triple" }

  $releaseDir = Join-Path $root "src-tauri\target\$triple\release"
  $bundleDir = Join-Path $releaseDir 'bundle'
  $exe = Join-Path $releaseDir 'Zenith.exe'
  if (-not (Test-Path $exe)) { $exe = Join-Path $releaseDir 'zenith-player.exe' }
  if (-not (Test-Path $exe)) { throw "release exe not found under $releaseDir" }

  $portableStage = Join-Path $outDir "Zenith-$version-windows-$tag-portable"
  if (Test-Path $portableStage) { Remove-Item -Recurse -Force $portableStage }
  New-Item -ItemType Directory -Force -Path $portableStage | Out-Null
  Copy-Item $exe (Join-Path $portableStage 'Zenith.exe')
  Copy-Legal $portableStage
  & (Join-Path $PSScriptRoot 'sign-windows.ps1') (Join-Path $portableStage 'Zenith.exe')

  $zip = Join-Path $outDir "Zenith-$version-windows-$tag-portable.zip"
  if (Test-Path $zip) { Remove-Item -Force $zip }
  Compress-Archive -Path (Join-Path $portableStage '*') -DestinationPath $zip -Force

  $nsisSrc = Get-ChildItem (Join-Path $bundleDir 'nsis') -Filter '*.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $nsisSrc) { throw "NSIS installer missing for $triple" }
  $nsisDest = Join-Path $outDir "Zenith_${version}_${tag}-setup.exe"
  Copy-Item $nsisSrc.FullName $nsisDest -Force
  & (Join-Path $PSScriptRoot 'sign-windows.ps1') $nsisDest

  $msiSrc = Get-ChildItem (Join-Path $bundleDir 'msi') -Filter '*.msi' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $msiSrc) { throw "MSI installer missing for $triple" }
  $msiDest = Join-Path $outDir "Zenith_${version}_${tag}.msi"
  Copy-Item $msiSrc.FullName $msiDest -Force
  & (Join-Path $PSScriptRoot 'sign-windows.ps1') $msiDest
}

Get-ChildItem $outDir -Recurse -Include *.exe, *.msi -ErrorAction SilentlyContinue |
  ForEach-Object {
    try { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue } catch {}
  }

Write-Host '== Windows artifacts (1 nsis + 1 msi + 1 portable per arch) =='
Get-ChildItem $outDir | Format-Table Name, Length, LastWriteTime
Get-ChildItem $outDir -Recurse -Include *.exe, *.msi | ForEach-Object {
  $sig = Get-AuthenticodeSignature $_.FullName
  Write-Host ("  {0}  {1}" -f $_.Name, $sig.Status)
}

# Rebuild portable zips after Azure (or any extra) signing of unpacked exe folders.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $root 'dist-artifacts\windows'
if (-not (Test-Path $outDir)) { throw "missing $outDir" }

Get-ChildItem $outDir -Directory -Filter '*-portable' | ForEach-Object {
  $zip = Join-Path $outDir ($_.Name + '.zip')
  if (Test-Path $zip) { Remove-Item -Force $zip }
  Compress-Archive -Path (Join-Path $_.FullName '*') -DestinationPath $zip -Force
  Write-Host "repacked $zip"
}

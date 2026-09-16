# Wipe compile scratch after a dist build.
# Keeps dist-artifacts/ (the installers you actually ship).
# Does not touch source, node_modules, icons, fonts, or git.

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

function Remove-IfExists([string]$Rel, [switch]$Recurse) {
  $path = Join-Path $root $Rel
  if (-not (Test-Path -LiteralPath $path)) { return }
  Write-Host "remove $Rel"
  Remove-Item -LiteralPath $path -Force -Recurse:$Recurse.IsPresent -ErrorAction Stop
}

Write-Host '== cargo clean (src-tauri/target) =='
if (Test-Path (Join-Path $root 'src-tauri\Cargo.toml')) {
  Push-Location (Join-Path $root 'src-tauri')
  cargo clean
  if ($LASTEXITCODE -ne 0) { Write-Warning "cargo clean exit $LASTEXITCODE" }
  Pop-Location
}

$dirs = @(
  'dist',
  'dist-ssr',
  '.vite',
  'coverage',
  'tmp',
  'temp',
  '_cert_work',
  'src-tauri\gen',
  'src-tauri\WixTools',
  'src-tauri\nsis'
)
foreach ($d in $dirs) {
  Remove-IfExists $d -Recurse
}

Get-ChildItem -LiteralPath $root -Filter '*.tsbuildinfo' -File -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "remove $($_.Name)"; Remove-Item $_.FullName -Force }

Get-ChildItem -LiteralPath $root -Filter 'qa-*.png' -File -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "remove $($_.Name)"; Remove-Item $_.FullName -Force }
Get-ChildItem -LiteralPath $root -Filter 'qa-*.json' -File -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "remove $($_.Name)"; Remove-Item $_.FullName -Force }

$scriptsDir = Join-Path $root 'scripts'
if (Test-Path $scriptsDir) {
  Get-ChildItem -LiteralPath $scriptsDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "remove scripts/$($_.Name)"; Remove-Item $_.FullName -Force }
}

foreach ($name in @('Zenith.exe', 'zenith-player.exe')) {
  Remove-IfExists $name
}

Write-Host '== kept =='
if (Test-Path (Join-Path $root 'dist-artifacts')) {
  Get-ChildItem (Join-Path $root 'dist-artifacts') -Recurse -File | Select-Object FullName, Length
} else {
  Write-Host '(no dist-artifacts yet)'
}
Write-Host 'temp clean done'

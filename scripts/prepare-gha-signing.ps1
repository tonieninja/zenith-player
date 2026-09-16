# GitHub Actions: write ZENITH_CODESIGN_PFX_BASE64 to certs/release.pfx
# and export ZENITH_CODESIGN_PFX for later steps via GITHUB_ENV

$ErrorActionPreference = 'Stop'

if (-not $env:ZENITH_CODESIGN_PFX_BASE64) {
  Write-Host '[sign] no ZENITH_CODESIGN_PFX_BASE64 - CI will skip Authenticode unless Azure Trusted Signing is set'
  exit 0
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dir = Join-Path $root 'certs'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$pfx = Join-Path $dir 'release.pfx'
$bytes = [Convert]::FromBase64String($env:ZENITH_CODESIGN_PFX_BASE64)
[IO.File]::WriteAllBytes($pfx, $bytes)

if ($env:GITHUB_ENV) {
  Add-Content -LiteralPath $env:GITHUB_ENV -Value "ZENITH_CODESIGN_PFX=$pfx"
}

Write-Host "[sign] wrote PFX ($($bytes.Length) bytes) for tauri signCommand"
exit 0

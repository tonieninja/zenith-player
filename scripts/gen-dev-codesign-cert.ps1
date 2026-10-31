# Local code-signing cert for this machine
# SmartScreen on GitHub downloads still needs Azure Trusted Signing or OV/EV
# For this PC: pnpm codesign:trust (Administrator) after this script

param(
  [switch]$ExportPfx,
  [switch]$Trust,
  [string]$PfxPassword = 'zenith-dev'
)

$ErrorActionPreference = 'Stop'
# Stable subject so Trusted Publisher matches what we sign with
$subject = 'CN=Zenith Player, O=Zenith Player, C=PL'

$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date) } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if ($existing) {
  Write-Host "Already have cert: $($existing.Thumbprint)"
  $cert = $existing
} else {
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -FriendlyName 'Zenith Player' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyExportPolicy Exportable `
    -KeySpec Signature `
    -HashAlgorithm SHA256 `
    -KeyLength 4096 `
    -NotAfter (Get-Date).AddYears(5)
  Write-Host "Created: $($cert.Thumbprint)"
}

Write-Host "Subject: $($cert.Subject)"
Write-Host "Thumbprint: $($cert.Thumbprint)"
Write-Host "Set for builds:"
Write-Host "  `$env:ZENITH_CODESIGN_THUMBPRINT = '$($cert.Thumbprint)'"

if ($ExportPfx) {
  $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  $dir = Join-Path $root 'certs'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $pfx = Join-Path $dir 'zenith-dev-codesign.pfx'
  $secure = ConvertTo-SecureString -String $PfxPassword -AsPlainText -Force
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
  Write-Host "Exported $pfx"
  Write-Host "  `$env:ZENITH_CODESIGN_PFX = '$pfx'"
  Write-Host "  `$env:ZENITH_CODESIGN_PASSWORD = '(the password you passed)'"
}

if ($Trust) {
  & (Join-Path $PSScriptRoot 'trust-local-publisher.ps1')
} else {
  Write-Host 'To stop SmartScreen on THIS PC for local builds, run as Administrator:'
  Write-Host '  pnpm codesign:trust'
}

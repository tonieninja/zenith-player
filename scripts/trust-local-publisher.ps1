# Installs the local Zenith code-signing cert into Trusted Publishers + Root
# so Explorer / SmartScreen stop treating locally built Zenith.exe as random junk
# Needs Administrator. Does not silence SmartScreen for GitHub downloads on other PCs

$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $here = $MyInvocation.MyCommand.Path
  Write-Host 'Elevating to Administrator (UAC)...'
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $here
  )
  exit $p.ExitCode
}

$subjects = @(
  'CN=Zenith Player, O=Zenith Player, C=PL',
  'CN=Zenith Player Dev'
)

$cert = $null
foreach ($subject in $subjects) {
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $subject -or $_.Subject -like "$subject*" } |
    Where-Object { $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if ($cert) { break }
}

if (-not $cert) {
  Write-Host 'No local signing cert, creating one first'
  & (Join-Path $PSScriptRoot 'gen-dev-codesign-cert.ps1')
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like '*CN=Zenith Player*' -and $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
}

if (-not $cert) {
  throw 'Could not create or find a Zenith code-signing certificate'
}

$tmp = Join-Path $env:TEMP ("zenith-publisher-" + $cert.Thumbprint + ".cer")
Export-Certificate -Cert $cert -FilePath $tmp -Type CERT | Out-Null

$stores = @(
  'Cert:\LocalMachine\TrustedPublisher',
  'Cert:\LocalMachine\Root',
  'Cert:\CurrentUser\TrustedPublisher',
  'Cert:\CurrentUser\Root'
)

foreach ($storePath in $stores) {
  $store = Get-Item $storePath
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $imported = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $tmp
  $store.Add($imported)
  $store.Close()
  Write-Host "Trusted: $storePath"
}

Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue

Write-Host "Publisher trusted: $($cert.Subject)"
Write-Host "Thumbprint: $($cert.Thumbprint)"
Write-Host 'Locally built, signed Zenith installers on this PC should no longer trip SmartScreen'
Write-Host 'GitHub downloads on other PCs still need Azure Trusted Signing or an OV/EV Authenticode cert'
exit 0

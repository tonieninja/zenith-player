# Authenticode for Tauri (tauri.conf.json signCommand, %1 = path)
#
# Order:
#   1) ZENITH_SKIP_CODESIGN=1
#   2) ZENITH_CODESIGN_PFX + ZENITH_CODESIGN_PASSWORD
#   3) ZENITH_CODESIGN_THUMBPRINT (CurrentUser or LocalMachine My)
#   4) CN=Zenith Player (local trusted publisher) then CN=Zenith Player Dev
#
# GitHub downloads still need Azure Trusted Signing or a bought OV/EV cert
# before SmartScreen reputation kicks in. Local trust is scripts/trust-local-publisher.ps1

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

$ErrorActionPreference = 'Stop'

if ($env:ZENITH_SKIP_CODESIGN -eq '1') {
  Write-Host "[sign] skipped (ZENITH_SKIP_CODESIGN=1): $FilePath"
  exit 0
}

if (-not (Test-Path -LiteralPath $FilePath)) {
  throw "[sign] file not found: $FilePath"
}

try {
  Unblock-File -LiteralPath $FilePath -ErrorAction SilentlyContinue
} catch {}

$Description = 'Zenith'
$ProductUrl = if ($env:ZENITH_CODESIGN_URL) {
  $env:ZENITH_CODESIGN_URL
} else {
  'https://github.com/tonieninja/zenith-player'
}

$TimestampServers = @(
  $(if ($env:ZENITH_CODESIGN_TIMESTAMP) { $env:ZENITH_CODESIGN_TIMESTAMP } else { $null }),
  'http://timestamp.digicert.com',
  'http://timestamp.acs.microsoft.com',
  'http://timestamp.sectigo.com'
) | Where-Object { $_ }

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "${env:ProgramFiles}\Windows Kits\10\bin"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.DirectoryName -match '\\x64$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Get-SignMaterial {
  $pfxPath = $env:ZENITH_CODESIGN_PFX
  if ($pfxPath -and (Test-Path -LiteralPath $pfxPath)) {
    $pass = $env:ZENITH_CODESIGN_PASSWORD
    if (-not $pass) {
      throw '[sign] ZENITH_CODESIGN_PASSWORD required with ZENITH_CODESIGN_PFX'
    }
    return @{ Kind = 'pfx'; Pfx = $pfxPath; Password = $pass }
  }

  $thumb = $env:ZENITH_CODESIGN_THUMBPRINT
  if ($thumb) {
    $thumb = $thumb.Replace(' ', '').ToUpperInvariant()
    $c = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
      Where-Object { $_.Thumbprint -eq $thumb } |
      Select-Object -First 1
    if (-not $c) {
      $c = Get-ChildItem Cert:\LocalMachine\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $thumb } |
        Select-Object -First 1
    }
    if (-not $c) {
      throw "[sign] thumbprint not found: $thumb"
    }
    return @{ Kind = 'store'; Cert = $c; Thumbprint = $c.Thumbprint }
  }

  $local = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.NotAfter -gt (Get-Date) }
  $preferred = $local |
    Where-Object { $_.Subject -eq 'CN=Zenith Player, O=Zenith Player, C=PL' } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if (-not $preferred) {
    $preferred = $local |
      Where-Object { $_.Subject -like '*CN=Zenith Player*' } |
      Sort-Object NotAfter -Descending |
      Select-Object -First 1
  }
  if ($preferred) {
    return @{ Kind = 'store'; Cert = $preferred; Thumbprint = $preferred.Thumbprint }
  }

  return $null
}

function Invoke-SignTool {
  param(
    [string]$Tool,
    [hashtable]$Material,
    [string]$Timestamp
  )
  $args = @(
    'sign', '/fd', 'SHA256', '/td', 'SHA256', '/tr', $Timestamp,
    '/d', $Description, '/du', $ProductUrl, '/v'
  )
  if ($Material.Kind -eq 'pfx') {
    $args += @('/f', $Material.Pfx, '/p', $Material.Password)
  } else {
    $args += @('/sha1', $Material.Thumbprint)
  }
  $args += $FilePath
  $p = Start-Process -FilePath $Tool -ArgumentList $args -Wait -PassThru -NoNewWindow
  return $p.ExitCode
}

$material = Get-SignMaterial
if (-not $material) {
  if ($env:GITHUB_ACTIONS -eq 'true') {
    Write-Warning '[sign] no certificate on CI - artifact stays unsigned'
    Write-Warning '[sign] set ZENITH_CODESIGN_PFX_BASE64 + ZENITH_CODESIGN_PASSWORD, or Azure Trusted Signing secrets'
    exit 0
  }
  Write-Warning "[sign] no certificate - leaving unsigned: $FilePath"
  Write-Warning '[sign] pnpm codesign:dev then pnpm codesign:trust (Administrator), or set a real PFX'
  exit 0
}

$who = if ($material.Kind -eq 'pfx') { "pfx:$($material.Pfx)" } else { $material.Cert.Subject }
Write-Host "[sign] $who -> $FilePath"

$signTool = Find-SignTool
$signed = $false
if ($signTool) {
  foreach ($ts in $TimestampServers) {
    Write-Host "[sign] signtool rfc3161 $ts"
    $code = Invoke-SignTool -Tool $signTool -Material $material -Timestamp $ts
    if ($code -eq 0) {
      $signed = $true
      break
    }
    Write-Warning "[sign] signtool exit $code with $ts"
  }
}

if (-not $signed) {
  $cert = $material.Cert
  if (-not $cert -and $material.Kind -eq 'pfx') {
    $secure = ConvertTo-SecureString -String $material.Password -AsPlainText -Force
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $material.Pfx,
      $secure,
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
    )
  }
  foreach ($ts in $TimestampServers) {
    try {
      Write-Host "[sign] Set-AuthenticodeSignature $ts"
      $result = Set-AuthenticodeSignature -FilePath $FilePath -Certificate $cert -TimestampServer $ts -HashAlgorithm SHA256
      if ($result.Status -ne 'NotSigned') {
        $signed = $true
        Write-Host "[sign] status=$($result.Status)"
        break
      }
    } catch {
      Write-Warning "[sign] timestamp $ts failed: $($_.Exception.Message)"
    }
  }
  if (-not $signed) {
    $result = Set-AuthenticodeSignature -FilePath $FilePath -Certificate $cert -HashAlgorithm SHA256
    if ($result.Status -eq 'NotSigned') {
      throw "[sign] failed: $($result.Status) $($result.StatusMessage)"
    }
    Write-Warning '[sign] signed without timestamp - get a reachable timestamp server before shipping'
    $signed = $true
  }
}

try {
  Unblock-File -LiteralPath $FilePath -ErrorAction SilentlyContinue
} catch {}

$check = Get-AuthenticodeSignature -FilePath $FilePath
Write-Host "[sign] status=$($check.Status) publisher=$($check.SignerCertificate.Subject)"
exit 0

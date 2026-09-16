# Release-gate QA: build with QA harness, run full+social+stability, join as WS guest.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$exe = Join-Path $root 'src-tauri\target\release\zenith-player.exe'
$dataDir = Join-Path $env:LOCALAPPDATA 'com.zenithplayer.desktop'

Set-Location $root
Get-Process zenith-player -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

Write-Host '== Building QA-enabled release (VITE_ZENITH_QA + feature qa) =='
$env:VITE_ZENITH_QA = '1'
$env:VITE_ZENITH_QA_AUTO = 'release'
pnpm tauri build -- --features qa
if ($LASTEXITCODE -ne 0) { throw "tauri build failed: $LASTEXITCODE" }

Get-ChildItem $dataDir -Filter 'qa_*.json' -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "Starting $exe"
Start-Process -FilePath $exe

$roomFile = Join-Path $dataDir 'qa_room_code.json'
$deadline = (Get-Date).AddMinutes(8)
while (-not (Test-Path $roomFile) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  Write-Host 'waiting for room code (full suite runs first)...'
  if (Test-Path (Join-Path $dataDir 'qa_room_err.json')) {
    Write-Host (Get-Content (Join-Path $dataDir 'qa_room_err.json') -Raw)
  }
}

$guestJob = $null
if (Test-Path $roomFile) {
  $room = Get-Content $roomFile -Raw | ConvertFrom-Json
  $port = if ($room.port) { [int]$room.port } else { 18765 }
  $code = [string]$room.code
  Write-Host ("ROOM CODE: {0} PORT: {1}" -f $code, $port)

  $guestJob = Start-Job -ScriptBlock {
    param($Port, $Code)
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $uri = [Uri]"ws://127.0.0.1:$Port/ws?code=$Code"
    try {
      $ws.ConnectAsync($uri, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      "connected"
      $buf = [byte[]]::new(8192)
      $end = [DateTime]::UtcNow.AddSeconds(180)
      while ([DateTime]::UtcNow -lt $end -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $seg = [ArraySegment[byte]]::new($buf)
        $result = $ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
        $text = [Text.Encoding]::UTF8.GetString($buf, 0, $result.Count)
        "packet:$($text.Substring(0, [Math]::Min(160, $text.Length)))"
      }
    } catch {
      "guest-error:$_"
    } finally {
      try { $ws.Dispose() } catch {}
    }
  } -ArgumentList $port, $code
} else {
  Write-Host 'NO ROOM CODE - social portion may have failed'
}

$report = Join-Path $dataDir 'qa_release_report.json'
$deadline2 = (Get-Date).AddMinutes(10)
while (-not (Test-Path $report) -and (Get-Date) -lt $deadline2) {
  Start-Sleep -Seconds 5
  Write-Host 'waiting for qa_release_report.json...'
  try {
    if (Test-Path $roomFile) {
      $p = (Get-Content $roomFile -Raw | ConvertFrom-Json).port
      $peers = (Invoke-WebRequest -Uri "http://127.0.0.1:$p/peers" -UseBasicParsing -TimeoutSec 2).Content
      Write-Host "peers=$peers"
    }
  } catch {}
}

Write-Host '==== GUEST JOB ===='
if ($guestJob) {
  Receive-Job $guestJob -ErrorAction SilentlyContinue | Select-Object -First 30
  Stop-Job $guestJob -ErrorAction SilentlyContinue
  Remove-Job $guestJob -Force -ErrorAction SilentlyContinue
}

Write-Host '==== RELEASE DUMPS ===='
foreach ($name in @(
  'qa_boot.json',
  'qa_full_report.json',
  'qa_social_report.json',
  'qa_room_peers.json',
  'qa_release_report.json'
)) {
  $f = Join-Path $dataDir $name
  if (Test-Path $f) {
    Write-Host "--- $name ---"
    Get-Content $f -Raw
  }
}

if (-not (Test-Path $report)) {
  throw 'qa_release_report.json missing'
}
$summary = Get-Content $report -Raw | ConvertFrom-Json
if (-not $summary.ok) {
  throw ("Release QA FAILED fails={0} warns={1}" -f $summary.fails, $summary.warns)
}
Write-Host ("Release QA PASS fails={0} warns={1}" -f $summary.fails, $summary.warns)

# Rebuild clean production (no QA harness / no dump feature)
Write-Host '== Building production distribution (no QA) =='
Remove-Item Env:VITE_ZENITH_QA -ErrorAction SilentlyContinue
Remove-Item Env:VITE_ZENITH_QA_AUTO -ErrorAction SilentlyContinue
Get-Process zenith-player -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
pnpm tauri build
if ($LASTEXITCODE -ne 0) { throw "production tauri build failed: $LASTEXITCODE" }

$nsis = Join-Path $root 'src-tauri\target\release\bundle\nsis'
Get-ChildItem $nsis -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "DIST: $($_.FullName)" }
Write-Host 'Production build ready.'

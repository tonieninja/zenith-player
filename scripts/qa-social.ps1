# Social QA: Discord + DualSense + Listening Room (agent as WS guest)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$exe = Join-Path $root 'src-tauri\target\release\zenith-player.exe'
$dataDir = Join-Path $env:LOCALAPPDATA 'com.zenithplayer.desktop'

Get-Process zenith-player -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Get-ChildItem $dataDir -Filter 'qa_*.json' -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "Starting $exe"
Start-Process -FilePath $exe

$roomFile = Join-Path $dataDir 'qa_room_code.json'
$deadline = (Get-Date).AddMinutes(3)
while (-not (Test-Path $roomFile) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  Write-Host 'waiting for room code...'
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

  # Agent joins as second client via .NET ClientWebSocket (no browser / PeerJS).
  $guestJob = Start-Job -ScriptBlock {
    param($Port, $Code)
    Add-Type -AssemblyName System.Net.Http
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $uri = [Uri]"ws://127.0.0.1:$Port/ws?code=$Code"
    $cts = [System.Threading.CancellationTokenSource]::new()
    $cts.CancelAfter([TimeSpan]::FromSeconds(15))
    try {
      $ws.ConnectAsync($uri, $cts.Token).GetAwaiter().GetResult()
      "connected"
      $buf = [byte[]]::new(8192)
      $end = [DateTime]::UtcNow.AddSeconds(100)
      while ([DateTime]::UtcNow -lt $end -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $seg = [ArraySegment[byte]]::new($buf)
        $result = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
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

  # Also open browser guest for visual confirm (optional).
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
  $server = $null
  if ($py -and $py.Source -notmatch 'WindowsApps') {
    $guestDir = Join-Path $root 'scripts'
    $server = Start-Process -FilePath $py.Source -ArgumentList @('-m','http.server','4177','--bind','127.0.0.1') -WorkingDirectory $guestDir -PassThru -WindowStyle Hidden
    Start-Process "http://127.0.0.1:4177/room-guest.html?code=$code&port=$port"
  }
} else {
  Write-Host 'NO ROOM CODE'
}

$social = Join-Path $dataDir 'qa_social_report.json'
$deadline2 = (Get-Date).AddMinutes(3)
while (-not (Test-Path $social) -and (Get-Date) -lt $deadline2) {
  Start-Sleep -Seconds 3
  Write-Host 'waiting for social report...'
  try {
    $peers = (Invoke-WebRequest -Uri "http://127.0.0.1:$((Get-Content $roomFile -Raw | ConvertFrom-Json).port)/peers" -UseBasicParsing -TimeoutSec 2).Content
    Write-Host "peers endpoint: $peers"
  } catch {}
}

Write-Host '==== GUEST JOB ===='
if ($guestJob) {
  Receive-Job $guestJob -ErrorAction SilentlyContinue | Select-Object -First 20
  Stop-Job $guestJob -ErrorAction SilentlyContinue
  Remove-Job $guestJob -Force -ErrorAction SilentlyContinue
}

Write-Host '==== SOCIAL DUMPS ===='
foreach ($name in @('qa_discord_ok.json','qa_discord_err.json','qa_dualsense.json','qa_room_code.json','qa_room_err.json','qa_room_peers.json','qa_social_report.json')) {
  $f = Join-Path $dataDir $name
  if (Test-Path $f) {
    Write-Host "--- $name ---"
    Get-Content $f -Raw
  }
}

if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }

# Maximum QA: API integration + in-app mega suite (all categories, moods, genres, plugins, auth).
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dataDir = Join-Path $env:LOCALAPPDATA 'com.zenithplayer.desktop'
$report = Join-Path $dataDir 'qa_mega_report.json'

Set-Location $root

Write-Host '== Backend API integration =='
node scripts/qa-api-integration.mjs
if ($LASTEXITCODE -ne 0) {
  Write-Warning "API integration exited $LASTEXITCODE (continuing mega UI suite)"
}

Get-Process zenith-player -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*zenith-player*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Get-ChildItem $dataDir -Filter 'qa_mega*.json' -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host '== Starting dev with VITE_ZENITH_QA_AUTO=mega (visible window) =='
$runId = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$devCmd = "cd /d `"$root`" && set VITE_ZENITH_QA=1&& set VITE_ZENITH_QA_AUTO=mega&& set VITE_ZENITH_QA_RUN_ID=$runId&& pnpm tauri dev"
$dev = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $devCmd -PassThru -WindowStyle Normal

$deadline = (Get-Date).AddMinutes(50)
while (-not (Test-Path $report) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 8
  foreach ($name in @('qa_mega_progress.json', 'qa_mega_start.json', 'qa_mega_timer.json', 'qa_mega_scheduled.json', 'qa_boot.json')) {
    $f = Join-Path $dataDir $name
    if (Test-Path $f) {
      try {
        $p = Get-Content $f -Raw | ConvertFrom-Json
        if ($p.stage) { Write-Host ("{0}: stage={1} total={2}" -f $name, $p.stage, $p.total) }
        elseif ($p.mode) { Write-Host ("{0}: mode={1}" -f $name, $p.mode) }
      } catch {}
    }
  }
  if ($dev.HasExited) {
    Write-Warning 'tauri dev exited early'
    break
  }
}

Write-Host '==== MEGA REPORT ===='
if (Test-Path $report) {
  $summary = Get-Content $report -Raw | ConvertFrom-Json
  Write-Host (Get-Content $report -Raw)
  if (-not $summary.ok) {
    throw ("Mega QA FAILED fails={0} warns={1}" -f $summary.fails, $summary.warns)
  }
  Write-Host ("Mega QA PASS fails={0} warns={1}" -f $summary.fails, $summary.warns)
} else {
  Get-ChildItem $dataDir -Filter 'qa_*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 Name,Length,LastWriteTime
  throw 'qa_mega_report.json missing'
}

try { Stop-Process -Id $dev.Id -Force -ErrorAction SilentlyContinue } catch {}
Get-Process zenith-player -ErrorAction SilentlyContinue | Stop-Process -Force

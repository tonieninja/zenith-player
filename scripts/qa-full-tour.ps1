# Full QA with per-stage screenshots when stage dumps appear.
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path (Join-Path $PSScriptRoot '..\src-tauri\target\release\zenith-player.exe')).Path
$outDir = Join-Path $PSScriptRoot '..\docs\screenshots'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$dataDir = Join-Path $env:LOCALAPPDATA 'com.zenithplayer.desktop'
$report = Join-Path $dataDir 'qa_full_report.json'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ZenCap2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Capture-Hwnd([IntPtr]$hwnd, [string]$path) {
  $r = New-Object ZenCap2+RECT
  [void][ZenCap2]::GetWindowRect($hwnd, [ref]$r)
  $w = [Math]::Max(1, $r.Right - $r.Left)
  $h = [Math]::Max(1, $r.Bottom - $r.Top)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][ZenCap2]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "Saved $path (${w}x${h})"
}

Get-Process zenith-player -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Get-ChildItem $dataDir -Filter 'qa_*.json' -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "Starting $exe"
Start-Process -FilePath $exe
Start-Sleep -Seconds 7
$p = Get-Process zenith-player -ErrorAction Stop
[void][ZenCap2]::ShowWindow($p.MainWindowHandle, 9)
[void][ZenCap2]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Seconds 1
Capture-Hwnd $p.MainWindowHandle (Join-Path $outDir 'full-01-boot.png')

$stages = @(
  @{ file='qa_stage_home.json'; shot='full-02-home.png' },
  @{ file='qa_stage_explore.json'; shot='full-03-explore.png' },
  @{ file='qa_stage_library.json'; shot='full-04-library.png' },
  @{ file='qa_stage_moods.json'; shot='full-05-moods.png' },
  @{ file='qa_stage_search.json'; shot='full-06-search.png' },
  @{ file='qa_stage_player.json'; shot='full-07-player.png' },
  @{ file='qa_stage_plugins_panel.json'; shot='full-08-plugins.png' },
  @{ file='qa_stage_settings.json'; shot='full-09-settings.png' },
  @{ file='qa_stage_queue.json'; shot='full-10-queue.png' }
)

$deadline = (Get-Date).AddMinutes(8)
$done = @{}
while ((Get-Date) -lt $deadline) {
  if (Test-Path $report) { break }
  $p = Get-Process zenith-player -ErrorAction SilentlyContinue
  if (-not $p) { break }
  foreach ($st in $stages) {
    $path = Join-Path $dataDir $st.file
    if ((Test-Path $path) -and -not $done.ContainsKey($st.file)) {
      Start-Sleep -Milliseconds 400
      [void][ZenCap2]::ShowWindow($p.MainWindowHandle, 9)
      [void][ZenCap2]::SetForegroundWindow($p.MainWindowHandle)
      Capture-Hwnd $p.MainWindowHandle (Join-Path $outDir $st.shot)
      $done[$st.file] = $true
      Write-Host ("stage {0}" -f $st.file)
    }
  }
  Start-Sleep -Seconds 2
}

$p = Get-Process zenith-player -ErrorAction SilentlyContinue
if ($p) {
  Capture-Hwnd $p.MainWindowHandle (Join-Path $outDir 'full-11-final.png')
}

if (Test-Path $report) {
  Write-Host 'QA REPORT SUMMARY'
  $r = Get-Content $report -Raw | ConvertFrom-Json
  Write-Host ("ok={0} fails={1} warns={2} skips={3} checks={4}" -f $r.ok, $r.fails, $r.warns, $r.skips, $r.checks.Count)
  $r.checks | ForEach-Object { "{0,-28} {1,-5} {2}" -f $_.id, $_.status, $_.detail }
} else {
  Write-Host 'NO FULL REPORT'
  Get-ChildItem $dataDir -Filter 'qa_*' | Sort-Object LastWriteTime | Select-Object Name,Length,LastWriteTime
}

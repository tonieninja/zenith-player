# Capture Zenith Player HWND via PrintWindow + wait for QA dumps.
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path (Join-Path $PSScriptRoot '..\src-tauri\target\release\zenith-player.exe')).Path
$outDir = Join-Path $PSScriptRoot '..\docs\screenshots'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$dataDir = Join-Path $env:LOCALAPPDATA 'com.zenithplayer.desktop'
$report = Join-Path $dataDir 'qa_full_report.json'
$release = Join-Path $dataDir 'qa_release_report.json'
$boot = Join-Path $dataDir 'qa_boot.json'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ZenCap {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Capture-Hwnd([IntPtr]$hwnd, [string]$path) {
  $r = New-Object ZenCap+RECT
  [void][ZenCap]::GetWindowRect($hwnd, [ref]$r)
  $w = [Math]::Max(1, $r.Right - $r.Left)
  $h = [Math]::Max(1, $r.Bottom - $r.Top)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  # PW_RENDERFULLCONTENT = 2
  [void][ZenCap]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Host "Saved $path (${w}x${h})"
}

Get-Process zenith-player -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Remove-Item $report,$boot -ErrorAction SilentlyContinue

Write-Host "Starting $exe"
Start-Process -FilePath $exe
Start-Sleep -Seconds 6

$p = Get-Process zenith-player -ErrorAction Stop
[void][ZenCap]::ShowWindow($p.MainWindowHandle, 9)
[void][ZenCap]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Seconds 2
Capture-Hwnd $p.MainWindowHandle (Join-Path $outDir 'qa-01-boot.png')

$deadline = (Get-Date).AddMinutes(12)
while ((-not (Test-Path $report)) -and (-not (Test-Path $release)) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 4
  $hasBoot = Test-Path $boot
  Write-Host ("waiting report... boot={0}" -f $hasBoot)
}
$p = Get-Process zenith-player -ErrorAction SilentlyContinue
if ($p) {
  [void][ZenCap]::ShowWindow($p.MainWindowHandle, 9)
  [void][ZenCap]::SetForegroundWindow($p.MainWindowHandle)
  Start-Sleep -Seconds 1
  Capture-Hwnd $p.MainWindowHandle (Join-Path $outDir 'qa-02-after-suite.png')
}

if (Test-Path $release) {
  Write-Host 'QA RELEASE REPORT:'
  Get-Content $release -Raw
} elseif (Test-Path $report) {
  Write-Host 'QA REPORT:'
  Get-Content $report -Raw
} elseif (Test-Path $boot) {
  Write-Host 'ONLY BOOT DUMP:'
  Get-Content $boot -Raw
  Get-ChildItem $dataDir | Sort-Object LastWriteTime -Descending | Select-Object -First 15 Name,Length,LastWriteTime
} else {
  Write-Host 'NO DUMPS'
  Get-ChildItem $dataDir -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 15 Name,Length,LastWriteTime
}

param(
  [int]$Interval = 30,
  [double]$Minutes = 60,
  [string]$Out = "zenith-soak-$(Get-Date -Format yyyyMMdd-HHmm).csv",
  [string]$Name = 'zenith-player',
  [double]$SkipMin = 10
)
$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture
$cores = [Environment]::ProcessorCount

# drzewo liczone przy kazdej probce, bo WebView2 potrafi zrestartowac renderer pod nowym PID
function Get-TreeIds {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name)
  $ids = @($all | Where-Object { $_.Name -eq "$Name.exe" } | ForEach-Object { $_.ProcessId })
  $added = $ids.Count -gt 0
  while ($added) {
    $added = $false
    foreach ($p in $all) {
      if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true }
    }
  }
  , $ids
}

function Format-Num($v) { [string]::Format($inv, '{0:F1}', $v) }

if ((Get-TreeIds).Count -eq 0) { Write-Error "$Name.exe is not running" }
Set-Content -Path $Out -Value 'time,elapsed_s,processes,ws_private_mb,cpu_pct,handles' -Encoding ascii
Write-Host "sampling $Name.exe and its children every $Interval s for $Minutes min into $Out"

$sw = [Diagnostics.Stopwatch]::StartNew()
$prevCpu = $null
$prevT = 0
$next = 0
while ($true) {
  $stamp = Get-Date -Format s
  $ids = Get-TreeIds
  $procs = @(if ($ids.Count) { Get-Process -Id $ids -ErrorAction SilentlyContinue })
  # czas CPU czytany zaraz po zegarze, bo zapytanie WMI ponizej trwa nawet kilka sekund
  $t = $sw.Elapsed.TotalSeconds
  $cpu = @{}
  foreach ($p in $procs) { $cpu[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds }
  if ($procs.Count -eq 0) {
    Write-Warning "$Name.exe is gone"
    $row = '{0},{1},0,,,' -f $stamp, [int]$t
    $prevCpu = $null
  } else {
    # prywatny zestaw roboczy jest tylko w licznikach wydajnosci; klasa WMI ma nazwy niezalezne od jezyka systemu
    $ws = (Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess, WorkingSetPrivate |
        Where-Object { $ids -contains $_.IDProcess } | Measure-Object WorkingSetPrivate -Sum).Sum
    $handles = ($procs | Measure-Object HandleCount -Sum).Sum
    $cpuPct = ''
    if ($prevCpu) {
      # proces nowy od ostatniej probki caly swoj czas CPU zuzyl w tym oknie
      $d = 0
      foreach ($id in $cpu.Keys) { $d += $cpu[$id] - $(if ($prevCpu.ContainsKey($id)) { $prevCpu[$id] } else { 0 }) }
      $cpuPct = Format-Num ($d / (($t - $prevT) * 1000 * $cores) * 100)
    }
    $prevCpu = $cpu
    $prevT = $t
    $row = '{0},{1},{2},{3},{4},{5}' -f $stamp, [int]$t, $procs.Count, (Format-Num ($ws / 1MB)), $cpuPct, $handles
  }
  Add-Content -Path $Out -Value $row -Encoding ascii
  Write-Host $row
  $now = $sw.Elapsed.TotalSeconds
  # spozniona probka nie nadrabia zaleglych, bo seria probek co kilka ms zawyza CPU
  $next = [math]::Max($next + $Interval, $now)
  if ($next -gt $Minutes * 60) { break }
  Start-Sleep -Milliseconds ([int](($next - $now) * 1000))
}

if (Get-Command node -ErrorAction SilentlyContinue) {
  node (Join-Path $PSScriptRoot 'summary.mjs') $Out "--skip-min=$SkipMin"
  exit $LASTEXITCODE
}
Write-Host "node not found; run: node scripts/bench/summary.mjs $Out --skip-min=$SkipMin"

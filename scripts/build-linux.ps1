# Linux AppImage + deb. Prefers Docker, then WSL, then native bash.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$outDir = Join-Path $root 'dist-artifacts\linux'
$image = 'zenith-player-linux:local'

function Test-DockerReady {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  docker info 1>$null 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Invoke-DockerLinuxBuild {
  Write-Host '== Linux build via Docker =='
  docker build -f Dockerfile.linux -t $image $root
  if ($LASTEXITCODE -ne 0) { throw 'docker build of Linux toolchain image failed' }

  if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  $outUnix = ($outDir -replace '\\', '/')
  docker run --rm `
    -v "${root}:/src" `
    -v zenith-player-linux-target:/src/src-tauri/target `
    -v zenith-player-linux-nm:/src/node_modules `
    -v "${outDir}:/out/linux" `
    $image
  if ($LASTEXITCODE -ne 0) { throw 'docker Linux build failed' }
}

function Invoke-WslLinuxBuild {
  Write-Host '== Linux build via WSL =='
  $wslRoot = (wsl wslpath -a $root).Trim()
  if (-not $wslRoot) { throw 'wslpath failed' }
  wsl -e bash -lc "bash '$wslRoot/scripts/build-linux.sh'"
  if ($LASTEXITCODE -ne 0) { throw 'WSL Linux build failed' }
}

if (Test-DockerReady) {
  Invoke-DockerLinuxBuild
} elseif (Get-Command wsl -ErrorAction SilentlyContinue) {
  $wslList = wsl -l -q 2>$null
  if ($LASTEXITCODE -eq 0 -and $wslList) {
    Invoke-WslLinuxBuild
  } else {
    throw 'WSL has no distro. Install Ubuntu (`wsl --install -d Ubuntu`) or Docker Desktop, then re-run pnpm dist:linux.'
  }
} elseif ($IsLinux) {
  bash (Join-Path $PSScriptRoot 'build-linux.sh')
  if ($LASTEXITCODE -ne 0) { throw 'native Linux build failed' }
} else {
  throw @'
Cannot build Linux on this PC: Docker is not running and WSL has no distro.

Install one of:
  winget install Docker.DockerDesktop
  wsl --install -d Ubuntu

Then reboot if Windows asks, start Docker, and run: pnpm dist:linux

GitHub Actions still builds Linux on ubuntu-22.04 for v* tags.
'@
}

if (-not (Test-Path $outDir) -or -not (Get-ChildItem $outDir -ErrorAction SilentlyContinue)) {
  throw "Linux artifacts missing under $outDir"
}

Write-Host '== Linux artifacts =='
Get-ChildItem $outDir | Format-Table Name, Length, LastWriteTime

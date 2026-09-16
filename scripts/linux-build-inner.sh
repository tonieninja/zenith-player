#!/usr/bin/env bash
# runs inside the Linux builder image (or any Ubuntu 22.04 box with Tauri deps)
set -euo pipefail

ROOT="${1:-/src}"
OUT="${2:-/out/linux}"
cd "$ROOT"

corepack enable
corepack prepare pnpm@9 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm tauri build --bundles appimage,deb

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
mkdir -p "$OUT"

shopt -s nullglob
appimages=(src-tauri/target/release/bundle/appimage/*.AppImage)
debs=(src-tauri/target/release/bundle/deb/*.deb)
if [[ ${#appimages[@]} -lt 1 || ${#debs[@]} -lt 1 ]]; then
  echo "Linux bundles missing (need AppImage + deb)" >&2
  ls -la src-tauri/target/release/bundle || true
  exit 1
fi

cp -f "${appimages[0]}" "$OUT/Zenith_${VERSION}_amd64.AppImage"
cp -f "${debs[0]}" "$OUT/Zenith_${VERSION}_amd64.deb"
chmod +x "$OUT/Zenith_${VERSION}_amd64.AppImage"
ls -la "$OUT"

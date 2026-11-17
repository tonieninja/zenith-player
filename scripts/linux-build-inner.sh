#!/usr/bin/env bash
# kontener Archa składa tylko AppImage; deb i rpm buduje CI na ubuntu-22.04, żeby zostały przy glibc 2.35
set -euo pipefail

ROOT="${1:-/src}"
OUT="${2:-/out/linux}"
cd "$ROOT"

if ! command -v pnpm >/dev/null; then
  corepack enable
  corepack prepare pnpm@10.18.3 --activate
fi
pnpm install --frozen-lockfile
pnpm typecheck
bash "$ROOT/scripts/build-appimage.sh"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
APP="src-tauri/target/release/bundle/appimage/Zenith_${VERSION}_amd64.AppImage"
if [[ ! -f "$APP" ]]; then
  echo "AppImage missing: $APP" >&2
  ls -la src-tauri/target/release/bundle || true
  exit 1
fi

mkdir -p "$OUT"
cp -f "$APP"* "$OUT/"
chmod +x "$OUT/${APP##*/}"
ls -la "$OUT"

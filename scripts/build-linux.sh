#!/usr/bin/env bash
# Native Linux / WSL: AppImage + deb into dist-artifacts/linux
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-artifacts/linux"
rm -rf "$OUT"
mkdir -p "$OUT"

if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "Need webkit2gtk 4.1. On Ubuntu/Debian:" >&2
  echo "  sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libudev-dev" >&2
  exit 1
fi

exec bash "$ROOT/scripts/linux-build-inner.sh" "$ROOT" "$OUT"

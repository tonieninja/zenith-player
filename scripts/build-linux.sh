#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-artifacts/linux"
rm -rf "$OUT"
mkdir -p "$OUT"

if [ ! -f /etc/arch-release ]; then
  echo "The AppImage builds on Arch Linux only (Docker: Dockerfile.linux, or WSL: wsl --install archlinux)." >&2
  echo "deb and rpm come from CI on ubuntu-22.04." >&2
  exit 1
fi

exec bash "$ROOT/scripts/linux-build-inner.sh" "$ROOT" "$OUT"

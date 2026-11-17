#!/usr/bin/env bash
# AppImage z własną glibc i loaderem (quick-sharun/sharun), więc startuje też na Ubuntu 22.04 i Debianie 12
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# narzędzie zakłada układ Archa: /usr/lib/webkit2gtk-4.1 z procesami WebKit, bez lib64 i libexec
if [ ! -f /etc/arch-release ]; then
  echo "build-appimage.sh needs Arch Linux (use Dockerfile.linux)" >&2
  exit 1
fi

QS_COMMIT=a159da2858637fc3e8c480581b2999640ebbfe30
QS_SHA256=6fc4f4561288297a7f8237f92b872656be1b7a4ba534f2b6cb9cfecabcddfd9d

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
OUT="$ROOT/src-tauri/target/release/bundle/appimage"
WORK="$ROOT/src-tauri/target/release/anylinux"
APP="$OUT/Zenith_${VERSION}_amd64.AppImage"

# bez bitu wykonywania AppImage nie otworzy żadnego linku; repo nie zawsze go przechowuje
chmod +x src-tauri/linux/xdg-open

pnpm tauri build --no-bundle

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/bin" "$OUT"
# updater szuka klucza linux-x86_64-appimage tylko przy typie paczki AppImage, a ten wpisuje sam bundler Tauri
node scripts/bundle-type-variant.mjs src-tauri/target/release/zenith-player "$WORK/bin/zenith-player" APP
chmod +x "$WORK/bin/zenith-player"
sed -e 's/{{name}}/Zenith/' -e 's/{{exec}}/zenith-player/' -e 's/{{icon}}/zenith-player/' \
  src-tauri/linux/zenith.desktop > "$WORK/zenith-player.desktop"
cp src-tauri/icons/128x128@2x.png "$WORK/zenith-player.png"

cd "$WORK"
curl -fsSL -o quick-sharun \
  "https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/$QS_COMMIT/useful-tools/quick-sharun.sh"
echo "$QS_SHA256  quick-sharun" | sha256sum -c -
chmod +x quick-sharun

export APPDIR="$WORK/AppDir" OUTPATH="$OUT" OUTNAME="${APP##*/}" VERSION
export DESKTOP="$WORK/zenith-player.desktop" ICON="$WORK/zenith-player.png"
# cpal gra przez ALSA; bez wtyczek PipeWire/Pulse w paczce trafiałby wprost na kartę zajętą przez serwer dźwięku
export DEPLOY_PIPEWIRE=1
# zasobnik systemowy Tauri ładuje appindicator przez dlopen, więc ldd go nie widzi
./quick-sharun ./bin/zenith-player /usr/lib/libayatana-appindicator3.so.1

# restart po aktualizacji z 4.5.0 dziedziczy zmienne starego AppRun (linuxdeploy), a tych sharun sam nie nadpisuje
echo 'unset GST_PLUGIN_PATH_1_0 GST_PLUGIN_SCANNER_1_0 GST_PTP_HELPER_1_0' >> "$APPDIR/.env"
cp "$ROOT/src-tauri/linux/xdg-open" "$APPDIR/bin/xdg-open"
# resource_dir Tauri to <katalog exe>/../lib/<productName>, a sharun uruchamia program z $APPDIR/bin
mkdir -p "$APPDIR/lib/Zenith"
cp "$ROOT/LICENSE" "$APPDIR/lib/Zenith/LICENSE"

./quick-sharun --make-appimage
if [ ! -f "$APP" ]; then
  echo "expected $APP, got:" >&2
  ls -la "$OUT" >&2
  exit 1
fi

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  cd "$ROOT"
  pnpm tauri signer sign "$APP"
fi
ls -la "$OUT"

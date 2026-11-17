#!/usr/bin/env bash
# usage: appimage-smoke.sh <AppImage>  (jako root w czystym kontenerze Debiana/Ubuntu, np. ubuntu:22.04)
set -euo pipefail

app="$(readlink -f "$1")"
chmod +x "$app"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# tylko serwer X, sesja D-Bus i czcionka, jak na najskromniejszym pulpicie; resztę AppImage ma nieść sam
apt-get install -y -qq --no-install-recommends xvfb x11-utils dbus procps fonts-dejavu-core ca-certificates >/dev/null

. /etc/os-release
echo "host: $PRETTY_NAME, $(ldd --version | head -n 1)"

export DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
for _ in $(seq 1 20); do xwininfo -root >/dev/null 2>&1 && break; sleep 0.5; done

# kontener nie ma FUSE, więc uruntime rozpakowuje obraz; APPIMAGE i APPDIR ustawia tak samo jak przy montowaniu
export APPIMAGE_EXTRACT_AND_RUN=1
log=/tmp/zenith-smoke.log
dbus-run-session -- "$app" >"$log" 2>&1 &
pid=$!

up=0
for i in $(seq 1 90); do
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "FAIL: Zenith exited after ${i}s"
    break
  fi
  if pgrep -f WebKitWebProcess >/dev/null && pgrep -f WebKitNetworkProcess >/dev/null \
    && xwininfo -root -tree | grep '"Zenith"' >/dev/null; then
    up=$i
    break
  fi
done
# okno i procesy WebKit muszą przetrwać jeszcze chwilę, sam start to za mało
if [ "$up" -gt 0 ]; then
  sleep 10
  kill -0 "$pid" 2>/dev/null || { echo "FAIL: Zenith exited within 10s after its window showed up"; up=0; }
fi

echo "--- processes"
ps -eo pid,args | grep -E 'zenith|WebKit' | grep -v grep || true
echo "--- windows"
xwininfo -root -tree | grep -i zenith || true
echo "--- log (last 60 lines)"
tail -n 60 "$log"
pgrep -f WebKitWebProcess >/dev/null || echo "FAIL: WebKitWebProcess is not running"
pgrep -f WebKitNetworkProcess >/dev/null || echo "FAIL: WebKitNetworkProcess is not running"
kill "$pid" 2>/dev/null || true

bad=0
if grep -E "symbol lookup error|error while loading shared libraries|undefined symbol|version .GLIBC" "$log"; then
  echo "FAIL: dynamic linker error, the bundled libraries do not cover this host"
  bad=1
fi
if [ "$up" -eq 0 ]; then
  echo "FAIL: no live Zenith window with WebKit processes on $PRETTY_NAME"
  bad=1
else
  echo "OK: window and WebKit processes up after ${up}s on $PRETTY_NAME"
fi
exit "$bad"

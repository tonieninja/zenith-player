# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/).
Versioning is SemVer. Legal context: [DISCLAIMER.md](./DISCLAIMER.md).

## Unreleased

### Added

- Plugin **Control by your internet** (`remote-control`, off by default): a LAN-only web remote.
  Mobile page in Zenith's style with now playing (cover, title, artist, progress), play/pause,
  next/previous, seek, volume and mute, like, shuffle, the queue with jump-to-track, and search
  with play / play next / add to queue. Live updates over a WebSocket, optional PIN with a
  brute-force lockout, configurable port, address and QR code in the plugin settings. No server
  exists while the plugin is off. See README → Control by your internet
- Remote extras: one-time QR link pairing (per-device keys, *Forget all devices*), `zenith.local`
  over mDNS, home-screen app (manifest + icons), synced lyrics tab, sleep timer, hold ⏮/⏭ to scrub
- Plugins **Equalizer** (15 ISO bands from 25 Hz to 16 kHz, peaking filters, automatic preamp,
  presets including **Bass Boost**) and **Loudness Normalization** (turns loud tracks down, never
  boosts), in Web Audio on Windows/macOS and GStreamer on Linux
- Plugin **Offline downloads**: save tracks and play them with no connection, with a manager to
  play or delete them. An *Offline* badge replaces the sign-in button when there is no internet
- Plugin **Global hotkeys** can now be rebound in its settings, and covers volume and like too
- **Gapless albums**: album tracks hand over with no gap, crossfade stays for everything else
- Plugin **Last.fm Scrobbler** (own API key; credentials stored encrypted and signed in Rust)
- Playlist folders in the sidebar (local only, they dont sync to YouTube Music)
- Windows installer: optional firewall rule for Zenith on **private** networks only; branded
  header/sidebar images; complete Polish translation (the checkboxes on the finish page had no
  labels in Polish because Tauri ships no Polish NSIS strings)
- Builds: Windows **x86 (32-bit)** setup and portable, Linux **.rpm**; AppStream metainfo,
  desktop entry with Polish strings; macOS dmg background and layout
- CI: Playwright E2E for the phone remote, idle CPU/RAM budget check, all platforms with signing
  and a `latest.json` covering every platform

### Fixed

- **Playback on school / office networks**: every track failed with "YouTube blocked the stream"
  where the network inspects HTTPS (own root certificate in Windows). yt-dlp now uses the Windows
  certificate store, retries once without the auto-detected proxy on a network error, and the
  innertube fallback still runs when yt-dlp cannot be downloaded (GitHub blocked). The give-up
  message names the cause (network block, YouTube bot check, component download, track)
- **Even more fallbacks for filtered networks**: after a network error yt-dlp now walks through
  direct (no proxy), system certificates, no certificate check for the link request only, and
  IPv4. Whatever worked is kept for the session. The audio download itself falls back between
  the system proxy and a direct connection. A failed audio download now counts as a network
  problem, so the message names the network instead of a generic "YouTube blocked the stream".
  Block pages from web filters are recognized as a network problem too
- Karaoke wipe on lines that wrap onto two rows: the rows now fill one after the other at one
  speed (the second row used to light up together with the first)

### Changed

- **Faster track start**: yt-dlp and the InnerTube player now race on every new track and the
  first usable link wins (before, InnerTube only ran after yt-dlp had failed). Stream links stay
  cached until a few minutes before YouTube's own `expire` time instead of a fixed 4 minutes, so
  replays and preloaded tracks start without another lookup. The cache holds 64 tracks and the
  preloader runs up to three lookups at once
- **Brand kit** in `assets/brand` (layered source SVG, variants, PNGs 16-1024, banners, social
  preview) with `scripts/brand/build-brand.py`, which also regenerates every app icon, the
  installer bitmaps and the favicon from the same two masters

- Windows (WebView2): additional browser switches turn off services the player never uses (spare
  renderer process, back/forward cache, SmartScreen, Translate, optimization hints, Cast, autofill
  server queries, out-of-process mini menus, component updater, sync, domain reliability,
  background networking). Lyrics overlay, second-screen lyrics and mini player now use exactly the
  same WebView2 options as the main window
- Lyrics: the active-line tracker sleeps until shortly before the next line instead of running on
  every display frame (200 times a second on a 200 Hz monitor); the line still switches on the same
  frame. Seeks and speed changes re-sync immediately
- Remember Queue: the 12-second save is skipped while paused (pausing already saves)
- WebView2 memory: after 30 s without focus the WebView gets the low memory target while staying
  visible (normal again on focus); minimized/tray as before
- Karaoke wipe pauses while the lyrics are scrolled off-screen or the window is hidden
- Small covers (queue, up next, mini player) load a 120 px thumbnail instead of 226-544 px; the
  cover cache resizes them
- Softer line-entry bounce in the synced lyrics
- App icon: transparent corners (the old one had white corners on dark taskbars/docks)

## 4.0.1 - 2026-11-05

### Fixed

- Linux clipboard shortcuts (Ctrl+V/C/X) no longer take down the app
- Lyrics matching is stricter, Genius HTTP 403 is handled, and Auto does not flash the wrong unsynced text
- Clicking an artist name opens the artist page instead of starting playback
- Library tabs show the first pages quickly, then fill the rest in the background
- Previous in shuffle goes through tracks you actually played
- CI builds Windows x64 and x86, Linux deb/AppImage/rpm, and macOS

## 4.0.0 - 2026-10-29

First public release. The changes first listed as "Unreleased" (portable exe, WebView2 check,
browse retry) and the fixes made on 29 October are folded in here; every 4.0.0 file was rebuilt
from the same commit.

### Added

- Playlist manager: every playlist in one window with search, sorting, counts and covers;
  rename, description, privacy, delete, multi-select remove, drag to reorder, duplicate, merge,
  CSV / JSON export and export to Spotify (PKCE login, fuzzy matching, list of missing tracks).
- Right-click a song to add it to one of your playlists.
- Library: Subscriptions and History tabs, and every tab loads past the first 25 items.
- Signed auto-update (Tauri updater, `latest.json` on GitHub Releases), one silent check after start
- Cover-art disk cache served by the loopback proxy (resized, 64 MB cap)
- Windowed rendering for long library sections and the queue
- Linux: native GStreamer audio engine in Rust (two decks, equal-power crossfade);
  Windows keeps the WebView `<audio>` path
- Linux: closing to the tray frees the WebView; playback, tray and media keys keep
  working, and the UI comes back on the same track without the splash
- Linux memory work: JavaScriptCore JIT off by default (`ZENITH_JIT=1`), WebKit memory
  pressure settings (`ZENITH_WEBKIT_MP`). See README → Performance

- Browse: Home, Explore, Moods, Search, Library and playlists from YouTube Music InnerTube
- Playback: yt-dlp for a stream URL, InnerTube `/player` as fallback, loopback proxy for CORS;
  queue, shuffle, loop, crossfade, A-B loop, sleep timer, variable speed
- Synced lyrics (LRCLib, Musixmatch, Genius, lyrics.ovh, YouTube captions) with karaoke fill,
  lyrics overlay, second-screen lyrics, mini player
- 31 plugins at release, 32 with Control by your internet ([docs/PLUGINS.md](docs/PLUGINS.md))
- Optional Google sign-in in a WebView; session cookies stay on the device (DPAPI on Windows)
- English and Polish UI and installer
- Packages: Windows NSIS installer (embedded WebView2 bootstrapper), Windows portable
  `Zenith_4.0.0_x64_portable.exe` (single file, static CRT), Linux `.deb` and `.AppImage`
  (GStreamer bundled). macOS universal `.dmg` built by GitHub Actions, untested
- Windows: at startup Zenith checks the WebView2 Runtime. If it is missing or older than major
  version 100, it downloads Microsoft's Evergreen bootstrapper, installs it silently and
  continues; if that fails it shows the manual download link
- Stream recovery: when YouTube answers 403/410/429 or the connection drops mid-track, the proxy
  fetches a fresh URL from another yt-dlp client (with that client's User-Agent) and resumes at the
  same byte; the client that worked is tried first next time. If no client works, Zenith looks
  for another upload of the same song (same title, duration within 7 s, "- Topic" channels
  first). Only then does it skip, with a growing pause between skips
- Windows: minimized or in the tray, the WebView is made invisible and asked to release memory
  (33-40 MB minimized, 90 MB in the tray, see README > Performance)

### Fixed

- The floating lyrics overlay no longer clips at the top or the side. It opens fully on
  screen at any display scaling, the lines are centred with even padding, the lines around
  the current one are easier to read, and the karaoke wipe sits right on the text.
- The phone remote no longer drifts down the page when the track changes. The queue
  scrolls inside its own box, and leaves you alone while you are touching the screen.
- Broken cover icons in the playlist manager are gone: playlists without a picture get a
  colour tile or a mosaic of their first tracks, and big playlists show their first tracks
  while the rest loads.
- Signing in could finish before YouTube set its own cookies, which left the library,
  playlists and liked songs empty. Sign-in now waits for them, and a session YouTube treats
  as signed out shows as signed out.
- Windows: Rust HTTP (feed, search, sign-in check, updater) now uses the system proxy, including
  WPAD/PAC auto-config, and the Windows certificate store. On networks with a proxy or a
  TLS-inspecting firewall (schools, offices) the feed failed to load and the sign-in window stayed
  open while the WebView itself was online
- Sign-in finishes when the popup has the Google session cookies even if the check against
  YouTube Music fails on a network error
- Windows: the next track started late or not at all while minimized (timers and
  `requestAnimationFrame` were throttled); fades and auto-advance now fall back to timers
- Windows: karaoke wipe drawn as one composited layer with a soft edge, no vertical seams; line
  changes scroll smoothly and long lyrics no longer jump after line 36
- YouTube Music browse requests are retried once (after 800 ms) on transport errors
- Paused lyrics view no longer burns CPU (karaoke columns were re-seeked every 50 ms)
- Playback fallback when YouTube bot-checks a client (yt-dlp last-resort pass)

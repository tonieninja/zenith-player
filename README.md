<p align="center">
  <img src="assets/banner.png" width="100%" alt="Zenith">
</p>

# Zenith Player

Desktop player for YouTube Music. Tauri 2 (Rust) with a React UI. Synced lyrics, gapless albums,
crossfade, a 15-band EQ, offline downloads, a phone remote and a pile of plugins. No ads, no telemetry.

<p align="center"><img src="docs/screenshots/tour.gif" width="760" alt="Zenith"></p>

Not an official YouTube or Google thing, just a player that talks to YouTube Music. Your account
and YouTube's terms still apply.

## Download

Grab it from [Releases](https://github.com/tonieninja/zenith-player/releases/latest).

| System               | File                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| Windows 10/11        | `Zenith_4.0.1_x64-setup.exe` (or `_x64_portable.exe` if you can't install stuff) |
| Old 32-bit Windows   | `Zenith_4.0.1_x86-setup.exe` / `_x86_portable.exe`                               |
| Debian, Ubuntu, Mint | `Zenith_4.0.1_amd64.deb`                                                         |
| Fedora, openSUSE     | `Zenith-4.0.1-1.x86_64.rpm`                                                      |
| Any Linux            | `Zenith_4.0.1_amd64.AppImage`                                                    |
| macOS 11+            | `Zenith_4.0.1_universal.dmg` (built by CI, I don't have a Mac to test it)        |

Windows builds aren't signed, so SmartScreen will complain. More info, Run anyway.
On macOS right click, Open the first time. `SHA256SUMS` is attached to every release.

## What it does

- Home, Explore, Search, Library, queue with drag and drop, shuffle, loop, radio after the queue ends
- Crossfade (2 to 12 s), gapless albums, A-B loop, speed with pitch kept, sleep timer
- Audio runs in a small Rust engine (symphonia + cpal), EQ and loudness normalization included.
  If it can't start, the app falls back to the old HTML audio
- Lyrics from LRCLib, Musixmatch, Genius, lyrics.ovh and YouTube captions, karaoke fill,
  always-on-top overlay and a second screen window
- Offline downloads, Last.fm scrobbling, Discord presence, DualSense, global hotkeys you can rebind
- Phone remote over your Wi-Fi (QR code, optional PIN, nothing leaves the LAN)
- Optional Google sign-in for your library, the session stays on your machine
- English and Polish

Full plugin list: [docs/PLUGINS.md](docs/PLUGINS.md).

## Screenshots

|                                           |                                             |
| ----------------------------------------- | ------------------------------------------- |
| ![Home](docs/screenshots/01-home.png)     | ![Explore](docs/screenshots/02-explore.png) |
| ![Lyrics](docs/screenshots/03-lyrics.png) | ![Search](docs/screenshots/04-search.png)   |
| ![Queue](docs/screenshots/05-queue.png)   | ![Plugins](docs/screenshots/06-plugins.png) |

## Phone remote

Turn on _Plugins, Utility, Control by your internet_. You get an address like
`http://192.168.x.x:8765/` and a QR code, open it on your phone on the same network.
Only local addresses get an answer. On Windows allow it on **private** networks when the firewall
asks, on Linux open the port (`sudo ufw allow 8765/tcp`). With the plugin off there's no server at all.

## Problems

- **Window doesn't open on Windows:** it needs the WebView2 Runtime. The installer sets it up,
  the portable exe installs it on first start.
- **Home stays empty / can't connect:** Zenith talks to `music.youtube.com` directly and trusts
  the Windows certificate store, so a proxy with its own root cert is fine. If it still fails,
  run it with `ZENITH_DEBUG=1` and open an issue with the log (no cookies in it).
- **Every track fails at school or work:** if the network really blocks YouTube there's not
  much to do. The error tells you why after three tracks.
- **High CPU in lyrics:** without a GPU the karaoke fill is expensive, turn on _Settings, Light lyrics mode_.
- **Reset:** delete `%LOCALAPPDATA%\com.zenithplayer.desktop` on Windows or
  `~/.local/share/com.zenithplayer.desktop` on Linux.

## Building

Node 20+, pnpm 10, Rust stable. On Linux also
`libwebkit2gtk-4.1-dev libasound2-dev libayatana-appindicator3-dev librsvg2-dev`.

```bash
pnpm install
pnpm tauri dev
pnpm test && pnpm typecheck
pnpm tauri build
```

CI in `.github/workflows/build.yml` builds Windows x64/x86, Linux deb/rpm/AppImage and the mac dmg.

## License

MIT, see [LICENSE](LICENSE). YouTube and Google names and logos belong to Google, the music and
lyrics belong to whoever owns them.

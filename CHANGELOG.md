# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/).
Versioning is SemVer. Legal context: [DISCLAIMER.md](./DISCLAIMER.md).

## 1.0.0 - 2026-09-15

### Added

- InnerTube catalog: Home, Explore, Moods, Search, Library, playlists
- WebView playback (`<audio>`): yt-dlp `-g` for a stream URL, InnerTube
  `/player` as fallback, loopback proxy for CORS
- Dual-deck engine: crossfade, queue, shuffle, loop, A-B, sleep timer
- Synced lyrics (LRCLib, Musixmatch, Genius, lyrics.ovh, YouTube captions)
  with karaoke fill
- Optional Google sign-in in a WebView (cookies remain on the device)
- Plugin registry (playback, visual, social, utility)
- Lyrics overlay, second screen, mini player
- GitHub Release artifacts: Windows NSIS/MSI, macOS DMG, Linux AppImage/deb
- Windows Authenticode via `sign-windows.ps1` (PFX or store cert, RFC 3161)
- Free GitHub release signing path: SignPath Foundation (Azure Artifact Signing
  is paid, kept as an optional fallback)
- In-app GitHub release check (Settings)
- NSIS English/Polish, embedded WebView2 bootstrapper, LICENSE in the bundle
- First-launch disclaimer acknowledgement
- Windows session cookies stored with DPAPI (`CryptProtectData`)
- `pnpm dist:linux` (Docker or WSL) for AppImage + deb

# Plugins

Zenith ships 35 plugins. Toggle them in the Plugins panel, the enabled set is stored in
`localStorage` key `zenith_plugins_enabled`.

A fresh install turns on the ones marked below (preload, queue and volume memory, smart lyrics
search, media keys, shortcuts, hotkeys and the tray), the rest is off. An existing install keeps
whatever you had.

### Playback

| Name                 | Id                  | On by default | What it does                                                                                                                                       |
| -------------------- | ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preload Next         | `preload-next`      | yes           | Prefetches stream URLs for the next 1-3 tracks in the queue.                                                                                       |
| Remember Queue       | `queue-persist`     | yes           | Restores your queue, position and resumes playback when you reopen Zenith.                                                                         |
| Remember Volume      | `remember-volume`   | yes           | Restores your last volume level between sessions.                                                                                                  |
| Crossfade            | `crossfade`         | no            | Equal-power blends between tracks near the end and on manual skips (2 to 12 s). Albums play gapless even when this is off (setting in the plugin). |
| Offline downloads    | `offline-downloads` | no            | Saves tracks to disk (app data folder, `downloads/`) and plays them with no connection. List, play and delete them in the plugin settings.         |
| Sleep Timer          | `sleep-timer`       | no            | Automatically stops playback after a set number of minutes.                                                                                        |
| Variable Speed       | `playback-speed`    | no            | Play tracks faster or slower.                                                                                                                      |
| A-B Loop             | `ab-loop`           | no            | Mark two points in a track and loop between them.                                                                                                  |
| Pause When Unfocused | `auto-pause-blur`   | no            | Pauses playback when you switch to another app or minimize Zenith.                                                                                 |

### Sound

| Name                   | Id                       | On by default | What it does                                                                                                     |
| ---------------------- | ------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Equalizer              | `equalizer`              | no            | 15-band graphic equalizer with presets (Bass Boost, treble, vocal, rock, electronic...).                         |
| Loudness Normalization | `loudness-normalization` | no            | Evens out volume between tracks: loud masters are turned down to a common level (never boosted, so no clipping). |
| Fade on Pause          | `fade-on-pause`          | no            | Fades the volume out on pause and back in on resume.                                                             |
| Smooth Volume          | `smooth-volume`          | no            | Ramps volume changes smoothly instead of jumping instantly.                                                      |
| Duck on Voice          | `duck-on-voice`          | no            | Lowers music volume when your microphone detects speech (Discord, calls).                                        |

### Lyrics

| Name                 | Id                     | On by default | What it does                                                                                                      |
| -------------------- | ---------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| Smart Lyrics Search  | `smart-lyrics`         | yes           | Cleans track titles before lyrics lookup (drops Artist - prefix and feat. credits). Turn off if a match is wrong. |
| Lyrics Overlay       | `lyrics-overlay`       | no            | Always-on-top transparent overlay with synced lyrics and automatic font size.                                     |
| Second Screen Lyrics | `second-screen-lyrics` | no            | Fullscreen lyrics on your second monitor with large, centered text.                                               |

### Control and remote

| Name                        | Id                   | On by default | What it does                                                                                                                                                                   |
| --------------------------- | -------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Media Session               | `media-session`      | yes           | OS Now Playing / lock-screen controls and media keys integration.                                                                                                              |
| Global Hotkeys & Media Keys | `global-hotkeys`     | yes           | Play/pause, next, previous, volume and like from any app. Defaults Ctrl+Alt+Space and Ctrl+Alt+←/→, every combo can be changed in the plugin settings. Media keys always work. |
| Keyboard Shortcuts          | `keyboard-shortcuts` | yes           | Space = play/pause, ←/→ or P/N = prev/next, Shift+←/→ = seek ±10s, ↑/↓ = volume, M = mute, Ctrl+F or / = search.                                                               |
| Control by your internet    | `remote-control`     | no            | Control Zenith from your phone or any device on your network: volume, play/pause, skip, seek, queue, like and search in a browser.                                             |
| DualSense Pad               | `dualsense-pad`      | no            | Control Zenith with a DualSense: touchpad swipe (next/prev/play) + face buttons. LED follows cover art while playing.                                                          |
| Webhook / Stream Deck       | `webhook`            | no            | POST JSON to a URL on every track change - works with Stream Deck, Home Assistant, n8n.                                                                                        |

### Sharing and services

| Name                  | Id                 | On by default | What it does                                                                                              |
| --------------------- | ------------------ | ------------- | --------------------------------------------------------------------------------------------------------- |
| Last.fm Scrobbler     | `lastfm-scrobbler` | no            | Scrobbles what you listen to to your Last.fm profile and shows "now playing" there.                       |
| Discord Rich Presence | `discord-rpc`      | no            | Shows the currently playing track, artist, cover art and a live progress bar on your Discord profile.     |
| Listening Room        | `listening-room`   | no            | Sync playback with friends over a local WebSocket room (same PC / LAN).                                   |
| Zenith Stage          | `zenith-stage`     | no            | Streamer pack: opens lyrics overlay and enables the share card in one toggle.                             |
| Share Card            | `share-card`       | no            | Makes a 1080×1080 Now Playing card and copies it to the clipboard.                                        |
| Copy Track Link       | `copy-track-link`  | no            | Right click the cover in the player to copy a clean YouTube Music link, with or without the current time. |

### Window and stats

| Name                 | Id                  | On by default | What it does                                                                                  |
| -------------------- | ------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| System Tray          | `system-tray`       | yes           | Closing the window keeps Zenith playing in the tray, with play/pause, next and show controls. |
| Dynamic Window Title | `window-title`      | no            | Updates the window title to show the current artist and track name.                           |
| Ambient Cover Glow   | `ambient-glow`      | no            | Tints the player backdrop with colors sampled from the current album art.                     |
| Mini Player          | `mini-player`       | no            | Compact always-on-top player with cover, progress and transport controls.                     |
| Listening Stats      | `stats-tracker`     | no            | Tracks total listening time and per-track play counts in the background.                      |
| Listening History    | `listening-history` | no            | Keeps a rolling log of the last 80 tracks you played (stored locally).                        |

## Control by your internet

When enabled, `src/plugins/remoteControl.ts` calls `remote_start` (Rust, `src-tauri/src/remote.rs`),
which binds `0.0.0.0:<port>` (default 8765, set in the plugin settings) and answers only peers with
a loopback, private (RFC 1918), CGNAT or link-local address.

| Route                                                         | What                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                                       | The remote page (`src-tauri/remote/index.html`, compiled into the binary)                                                         |
| `GET /api/state?pin=`                                         | Last state snapshot as JSON (`401` wrong PIN, `429` locked for 60 s after 8 misses)                                               |
| `GET /api/pair?t=`                                            | One-time link mode: trades the single-use QR token for a per-device key (`{key}`), then rotates the token                         |
| `GET /manifest.webmanifest`, `/icon-256.png`, `/icon-512.png` | Home-screen app (PWA) manifest and icons                                                                                          |
| `GET /ws?pin=`                                                | WebSocket. Server → phone: `{"type":"state",...}` on every change, `{"type":"search","req",items}`. Phone → server: `{"cmd":...}` |

Commands (validated and clamped in Rust, then emitted to the main window as `zenith-remote-cmd`):
`toggle`, `play`, `pause`, `next`, `prev`, `like`, `mute`, `shuffle`, `loop`, `volume {value 0-1}`,
`seek {value s}`, `jump {index}`, `sleep {minutes 0-600}`, `search {query, req}`, `playTrack|playNextTrack|addTrack {track}`.

State is pushed by `App.tsx` only when something visible changes (track, play/pause, seek,
volume, mute, like, shuffle, queue, duration); progress is a timestamped anchor the page
interpolates, so a connected but idle phone costs nothing. Turning the plugin off stops the server
and closes every socket. Settings (port, PIN, pair mode) live in `localStorage` (`zenith_remote_port`,
`zenith_remote_pin`, `zenith_remote_pair`). Every request authenticates with `?key=` (paired device),
`?pin=`, or nothing when there is no PIN and pair mode is off. Paired device keys are stored in
`remote_devices.json` in the app data folder (max 32; _Forget all devices_ clears it). Synced
lyrics are pushed once per track as `{"type":"lyrics",synced:[{t,x}],plain}`. The server announces
`zenith.local` / `_http._tcp` "Zenith Remote" over mDNS (`ZENITH_REMOTE_MDNS=0` disables it).

Tests: `cargo test --lib remote` (routes, PIN, pairing, manifest) and `pnpm e2e` (Playwright on a
phone viewport against the real server: PIN gate, controls, hold-to-scrub, sleep sheet, lyrics).

## Equalizer and loudness normalization

- All platforms play through the Rust engine (`src-tauri/src/native_audio`): peaking biquads
  (Q 1.4) in `dsp.rs` with a preamp that keeps boosted bands from clipping.
- `src/audio/webFx.ts` is only used when the Rust engine can't open an output device, and in the
  browser build used by the e2e tests.
- Normalization measures the first ~12 s of each track (RMS, gated below −50 dB), then turns tracks
  louder than −16 dBFS down by up to 10 dB, in ≤1 dB steps. Quiet tracks are never boosted.
  Element volume is divided out of the measurement (verified: Chromium applies `audio.volume`
  before the Web Audio graph).

## Last.fm Scrobbler

Bring your own API account (free, <https://www.last.fm/api/account/create>). The key, shared secret
and session key are stored encrypted (`lastfm.bin` in the app data folder, DPAPI on Windows, 0600
file elsewhere) and every request is signed in Rust (`src-tauri/src/lastfm.rs`); the web view never
sees them. Scrobble rule: track longer than 30 s, listened (real playback, not seeks) for half its
length or 4 minutes. Failed scrobbles wait in `localStorage` `zenith.lastfm.queue` (max 50).

## Writing a plugin

1. Create `src/plugins/myPlugin.ts` exporting an object that implements `ZenithPlugin`
   (`src/plugins/types.ts`):

```ts
import type { ZenithPlugin } from './types';

export const myPlugin: ZenithPlugin = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'One sentence about what it does.',
  category: 'utility', // playback | visual | social | utility
  defaultEnabled: false,
  onTrackChange(info, previousId) {
    /* fires on track id change */
  },
  onPlayStateChange(isPlaying) {},
  onSeek(position) {},
  onNowPlaying(info) {
    /* progress ticks */
  },
  onAppFocus(focused) {},
  onEnable() {},
  onDisable() {
    /* undo everything onEnable did */
  },
};
```

2. Register it in `src/plugins/index.ts` (`ALL_PLUGINS`, alphabetical).
3. Add the Polish name/description in `src/utils/pluginI18n.ts`.
4. Optional settings UI: `src/components/PluginsPanel.tsx` (`renderSettings`).
5. Keep hooks cheap: `onNowPlaying` runs on every progress tick. Plugins must not
   download media or send data anywhere unless that is their stated purpose.

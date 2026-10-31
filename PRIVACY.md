# Privacy

Zenith has no telemetry, analytics, crash reporting or ads. Nothing is sent to the
Zenith authors.

Network requests the app makes, and why:

| Host | Purpose |
| --- | --- |
| music.youtube.com, www.youtube.com, *.googlevideo.com, i.ytimg.com | catalog, search, playback streams, artwork |
| accounts.google.com | only if you sign in (session stays in the local webview profile) |
| lrclib.net, musixmatch.com, genius.com, api.lyrics.ovh | lyrics lookup for the current track |
| github.com (`/tonieninja/zenith-player/releases/latest/download/latest.json`) and its release downloads | one auto-update check ~20 s after start (opt out: `localStorage` `zenith_auto_update_check=0`); update packages are signature-checked |
| api.github.com, github.com | Settings → *Check for updates*; yt-dlp version check and download |
| 127.0.0.1 (loopback only) | local stream proxy and resized cover-art cache (on disk, 64 MB cap); not reachable from other machines, token-protected |
| discord.com | Discord Rich Presence, only if enabled |
| go.microsoft.com (and Microsoft's WebView2 download servers) | Windows only, only when the WebView2 Runtime is missing or older than version 100: Zenith downloads Microsoft's Evergreen bootstrapper once and runs it; the bootstrapper then talks to Microsoft |
| your proxy (if Windows has one configured, including WPAD/PAC auto-config) | all of the above go through it, the same way your browser's traffic does |
| ui-avatars.com | placeholder avatar when an account has no picture |
| user-configured URL | Webhook plugin, only if you enable it |
| ws.audioscrobbler.com, www.last.fm | Last.fm Scrobbler, only if you enable it and connect your account: artist, title, album, duration and the time you played it are sent to your Last.fm profile |
| devices on your local network | Control by your internet plugin, only if you enable it: a LAN-only server (optional PIN) shows now playing / queue to browsers on your network and accepts their commands; nothing leaves your network. It also announces `zenith.local` over mDNS (multicast on the LAN only). Paired device keys are stored in `remote_devices.json` |

Local data (settings, library cache, listening stats, session, offline downloads) lives in the app data
directory (`%LOCALAPPDATA%\com.zenithplayer.desktop` on Windows,
`~/.local/share/com.zenithplayer.desktop` on Linux) and never leaves the machine.
Remove it to reset the app.

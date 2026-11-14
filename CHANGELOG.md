# Changelog

## 4.0.1

- audio plays from a Rust engine now (symphonia + cpal), EQ and loudness normalization went with it.
  HTML audio is still there as a fallback
- stream links are resolved in Rust, no more yt-dlp, Python or Deno downloads
- crossfade starts where the song really ends, so no silence after long fade outs
- Next at the end of the queue keeps going with the song's radio
- lyrics overlay fills like the in-app lyrics without turning on karaoke mode,
  second screen fill reaches the end of the line, mini player bar is smooth
- overlay, second screen and mini player windows are created when you open them and gone when you close them
- phone remote plugin (LAN only, QR pairing, optional PIN)
- 15-band EQ, offline downloads, rebindable global hotkeys, Last.fm, playlist folders
- Windows x86 builds and a Linux rpm
- fixed: random "YouTube blocked playback", school networks with their own root cert, Linux
  clipboard shortcuts crashing the app, AppImage stuck at 0:00, Musixmatch picking the wrong song,
  duration stuck at 0:00 after a track change, new playlists losing their name

## 4.0.0

- first public version: Home, Explore, Search, Library, playlists, queue, crossfade, A-B loop,
  sleep timer, speed
- synced lyrics with karaoke fill, overlay, second screen lyrics, mini player
- playlist manager with export to CSV, JSON and Spotify
- optional Google sign-in, cookies stay on the device
- signed auto-update, cover cache, close to tray

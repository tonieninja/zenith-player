# Changelog

## 4.1.1

- EQ no longer turns the whole song down, a limiter keeps it from clipping instead
- bass boost has its own slider and hits the bass you can actually hear, changes glide without clicks
- lyrics switch lines right on time instead of half a second late, line changes are one smooth slide
- second screen lyrics can hide the title and artist
- mini player progress bar takes its colours from the cover
- ambient glow tints the background with the cover again
- Discord shows "Listening to <song>", clickable title and artist, the playlist you play from and two buttons
- phone remote got bigger buttons and sliders, no zoom on tap, works around the notch, two columns on tablets
- share card button is clearly visible and tells you if copying worked
- the cover in the player no longer shows a resize cursor
- karaoke mode plugin is gone, it did nothing the lyrics don't already do

## 4.1.0

- DualSense works over Bluetooth, not only on a cable
- the lightbar takes its colour from the cover, dims on pause and flashes on next, previous and play
- the pad reconnects by itself after you turn it off and on again
- Duck on Voice listens to the mic in Rust and has a live meter with the threshold on it,
  so you can see when it kicks in
- right click the cover in the player to copy a clean link, also from the current time
- share card copies to the clipboard again, scrolling on the cover no longer scrolls the page
- support link in Settings, About
- new update signing key, older builds have to grab 4.1.0 by hand once

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

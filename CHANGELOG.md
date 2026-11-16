# Changelog

## 4.3.0

- the mini player can show the current lyric line with the karaoke fill, and you pick which buttons it has (idea from Grex_Vibra on reddit)
- closing to the tray drops the main window after 30 s while the Rust engine keeps playing, tray, hotkeys and the mini player keep working
- with the main window and the mini open Zenith takes around 260 MB instead of 500, in the tray with just the mini around 55 MB, and with nothing open 15 MB
- far fewer wakeups while a song plays: the audio thread, the lyrics view and the phone remote only work when something changes
- romanized lyrics for Japanese, Korean, Chinese and Cyrillic, worked out on your computer, and translated lyrics through Google Translate
- plain lyrics without timing scroll and get romanization and translation too
- SponsorBlock skips talking, skits and sponsor breaks in music videos
- albums play gapless down to the sample, pausing fades out instead of cutting off
- right-click a track to download it for offline
- plain lyrics show as soon as they arrive, long instrumental breaks get a ♪ line, lyrics for the wrong version of a song get rejected more often
- the karaoke fill follows playback speed, right-to-left lyrics show without it, duet lines sung together share one line
- auto-generated YouTube captions are no longer shown as lyrics
- phone remote: the PIN no longer gets in when the one-time QR link is on, wrong PIN lockouts get longer each time, the firewall rule covers private networks only
- the Google sign-in window only opens Google's own pages
- player bar, sidebar, menus and dialogs work from the keyboard and with a screen reader, toasts stay up longer and wait while you hover them
- clearing the queue can be undone
- Polish texts read better, and errors show up in Polish instead of English
- Spotify import stops on a rate limit instead of quietly matching nothing, adding to a playlist skips songs already in it
- startup no longer waits for proxy auto-detection
- Linux: on NVIDIA under Wayland Zenith sets the WebKitGTK workarounds itself and starts natively instead of not starting at all, the JavaScript JIT is back on and the 100 MB WebKit memory cap is gone, both slowed the interface down
- the pause icon's bars no longer melt into one, text fields use the app font
- lots of smaller fixes in the library cache, likes, the playlist manager, downloads and the mini player position

## 4.2.1

- "Open Zenith" at the end of the installer actually opens Zenith now
- the Windows installer has a dark look that matches the app, with a dark title bar
- fewer steps: no license page and no Start menu folder page, installing a newer version just updates in place
- a running Zenith gets closed by the installer itself, no white popup asking first
- the firewall question for the phone remote is an option on the last page instead of a popup in the middle
- picking Uninstall on the "already installed" page closes the installer when it's done
- the Next button in the welcome tour sits in the middle until there's a Back button next to it

## 4.2.0

- six more places to get lyrics from: LyricsPlus, Boidu (Apple Music timing), Unison, NetEase, QQ Music and Kugou
- the last four only get asked when the usual ones have no synced lyrics, credit lines get dropped
- songs download from YouTube in 10 MiB pieces, so long tracks and mixes don't get slowed down halfway
- loudness normalization starts from the level YouTube reports when there is one, so the first seconds are not too loud
- stream links survive a restart, the first song after opening the app starts faster
- ListenBrainz scrobbling next to Last.fm, paste your token in the plugin settings
- import a Spotify playlist into YouTube Music from the playlist manager
- CI checks Rust formatting and clippy

## 4.1.3

- phone remote refuses to pair if Windows can't give it a random code, instead of making a weak one
- playlists without a cover get their letter tile drawn by the app, the name no longer goes to ui-avatars.com
- the system media panel only gets real cover links

## 4.1.2

- the lyrics view uses way less CPU and GPU while a song plays, looks exactly the same
- new look for the Windows installers (setup.exe and msi) and the macOS dmg
- installer pages reworded in English and Polish

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

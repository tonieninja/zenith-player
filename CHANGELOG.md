# Changelog

## 4.8.0

- search works like in YouTube Music: suggestions and quick results with covers while you type, your recent searches, and chips above the results to show only songs, videos, albums, artists, playlists, podcasts or profiles, loading more as you scroll. Typing no longer redraws the whole window
- radios and mixes can be tuned with the chips above Up next (Familiar, Popular, Discover, Deep cuts and more), the current song keeps playing
- Cast: send the music to a Chromecast or Google TV from the button in the player bar. Play, pause, seek, skip and volume go to the TV and the queue moves on there
- light theme, or let Zenith follow the system (Settings, Appearance)
- start with the system, optionally straight into the tray (Settings)
- signed in, Home and the mood pages show your own mixes like in YouTube Music: Mixed for you, Recaps, Supermixes, Forgotten favorites
- My library: collections, folders and tags kept on this computer. Songs you have on disk play from the file instead of the stream
- listening stats with a taste map, rising artists and Last.fm history import. Repeat one counts every play
- Home shows the last feed right away on start, its shelves get More buttons and song lists, and it keeps loading as you scroll. Hide a shelf you don't want and bring it back in Settings, it stays hidden after a language switch
- albums, playlists and artists open at once when you come back to them or hover them first
- playlists open their page like in YouTube Music, play buttons start them at once. Go to album works for every song
- covers shimmer while they load, the music note is only for covers that are really missing
- eight accent colours, and all settings can be saved to one file and brought back on another computer
- queue and volume memory, preload, crossfade and close to tray moved from plugins into Settings, every lyrics setting now lives in the lyrics window
- playback: the Rust engine starts the next song and does the crossfade. A radio that continues after an album crossfades again instead of being stitched like the album, and it no longer serves the same song in five remixes
- downloaded m4a files carry the title, artist, album and cover too
- Windows: the taskbar preview shows the cover and its buttons keep working while the window sleeps in the background. A window fully covered by others stops drawing until you can see it again
- plugins: switching one off leaves nothing running behind it, the sleep timer no longer starts by itself, the Last.fm import rides out rate limits, Discord catches up within a second, and the phone remote shows lyrics and the sleep countdown right away
- Discover plugin: a Home row from outside the YouTube Music bubble
- songs play again with YouTube's newest player. A broken audio file no longer closes the app, and database work no longer freezes the window
- lots of smaller fixes: the song menu works with Escape and arrow keys, narrow windows, loading placeholders that match the finished page, rounded scrollbars, the mini player and the lyrics overlay

## 4.7.0

- a lot less memory: closed to the tray the window goes away after 30 s and only the small Rust engine keeps playing, about 15 MB. On Windows the same happens after 90 s minimized, the taskbar button stays and a click brings the window back where you left it
- with the window open Zenith takes about 100 MB less, the WebView no longer runs a separate GPU process
- scrobbling, Discord, the webhook, listening stats, SponsorBlock, the sleep timer and blocked artists keep working while the window is gone
- the next song starts about 150 ms after the last one ends, also without crossfade, and its lyrics are already there
- new plugins, all off by default: Skip AI music (a community list from Soul Over AI and Spotify AI Blocker), Block artists, Music video in place of the cover, Taskbar buttons under the preview (Windows) and zenith:// links
- lyrics: put the 11 sources in your own order, star the one you like most and switch off the rest. Auto shows the first lyrics right away and moves up to a better source when it answers. All sources fit in the panel now and the button next to the arrows opens their settings
- Settings: pick the audio output device. Unplug the headphones and it goes to the default, plug them back and it comes back
- downloads can carry the title, artist and cover inside the file (switch in the downloads settings)
- playlists, albums and Favorites open as a track list with Play and Shuffle. The sidebar keeps just navigation and playlists, Moods & genres sits at the end of the chips on Home
- Now Playing: the artist and album of the current song open with a click
- one song that fails no longer floods YouTube with requests until nothing plays at all. A rate limit stops the queue with a message instead of skipping through everything, and Settings has a playback log to paste into bug reports
- Discord checks that the status actually went through and tries again, the card shows a bigger cover and a pause badge
- phone remote: nobody gets in while the server is off, and phones drop when you change the PIN
- smaller fixes: the seek bar no longer jumps back after a seek, playback that got stuck starts again, no more sign-out flicker, tiles missing on Home or lost scrobbles, a half-loaded playlist can't be saved short, episode cards play in Explore
- less CPU while playing or paused, API answers come compressed and the first song starts sooner

## 4.6.1

- Home: the play button on artist cards sits in the middle of the round photo, before the circle cut it off in the corner
- plugin names in the Plugins window are written in sentence case
- clearer wording in the Windows installer, the missing WebView2 message, the error screen and the phone remote

## 4.6.0

- artist pages got a proper header with the photo and subscribers, Play all plays every song of the artist like a playlist, next to it Shuffle, Radio and Show all
- age-restricted songs play without signing in: Zenith finds the same song on YouTube Music (it usually has no age gate) or uses the embedded player. You can turn it off in Settings → Bypass age restriction
- signed in, age-restricted songs go through the YouTube Studio client too, like the browser extensions do
- one age-restricted song no longer made the next songs fail for 10 minutes, YouTube's age check was taken for a bot block
- songs with an ad in front of them play again, before they failed on the first try
- when a song really can't play, Zenith says why (age restriction, removed, not in your country) on the first try instead of after three
- Windows: the firewall question for the phone remote really shows the Windows admin prompt, in the installer and in the portable exe. It used to open behind the window or not at all
- Windows: the phone remote works on networks Windows marks as Public (school, hotel) if you allow it there, and Zenith spots the blocking rule Windows adds when its own popup is cancelled
- Linux: global hotkeys are off by default, media keys and the desktop media widget work through MPRIS, so KDE and GNOME no longer ask to allow shortcuts on start. Turn them on in Plugins for extra key combos
- Linux: seeking, volume, shuffle and repeat work from the desktop media widget, its progress bar moves
- AppImage: carries its own glibc, so it runs on Ubuntu 22.04, Debian 12 and Mint 21 again, and 4.5.0 AppImages update to it on their own
- AppImage: built with WebKitGTK 2.54 without the Ubuntu patch, so NVIDIA cards draw the interface on the GPU instead of the CPU
- deb on Debian and Ubuntu with NVIDIA: Zenith turns off the distro patch that forced the whole interface onto the CPU

## 4.5.0

- the portable exe updates itself in place instead of installing the setup next to it. Portable 4.4.0 and older can't do that yet, so download this one by hand once
- the portable exe asks once if Windows Firewall may let the phone remote through, before only the installer asked
- Linux: global hotkeys work on Wayland through the desktop's shortcut portal (KDE Plasma 6, GNOME 48 and newer, deb and rpm), the desktop asks once to allow them
- Linux on KDE Wayland: the mini player and the lyrics overlay stay on top and out of the taskbar
- Linux on Wayland: Zenith shows its own icon in the taskbar and Alt+Tab, lyrics on a second screen open fullscreen on that screen
- Linux on NVIDIA: Explore no longer hangs with Fedora's WebKit 2.54. If WebKit crashes or stops responding, Zenith restarts on a safer renderer and picks the song up where it was
- Linux on NVIDIA: WebKit on the 580 driver loses a file handle every frame, Zenith raises the limit so it no longer dies after a minute
- Linux on laptops where the screen runs on the Intel or AMD chip: the fallback skips the renderer mode that could freeze there
- AppImage: Spotify, Last.fm and donate links open in your browser, Fedora's Firefox didn't start from inside the AppImage
- rpm on Fedora 45 and newer: rpm refuses unsigned packages there, so Zenith links the new release instead of an update that would fail. Fedora 44 and older still update in one click
- the rpm no longer requires Fedora package names, so it installs on openSUSE too
- Linux: the deb and rpm install a udev rule, so the DualSense works without root and without replugging
- macOS: the default app menu with Quit and Hide is back, the Dock icon brings the window back from the tray, media keys go through Now Playing without asking for accessibility access, the pad isn't taken away from other apps
- Windows: reinstalling cleans up the old uninstaller, uninstalling asks for admin once to really remove the phone remote firewall rules and leaves other accounts' installs alone
- fewer GPU layers on every screen, loading placeholders no longer repaint every frame
- the playback position is saved on its own instead of rewriting the whole queue every time
- Explore: the trending list keeps fitting the window after paging, and each tab opens at the top instead of where the last one was scrolled
- Tauri 2.12 and updated dependencies

## 4.4.0

- Linux on NVIDIA: when the fast renderer can't start, the fallback keeps drawing on the graphics card and only copies the frame through RAM. The old fallback drew the whole interface on the CPU, which made Zenith crawl on 4K screens
- Linux: opening Zenith a second time while it runs no longer pins the next start to the slow renderer
- Linux: the karaoke fill moves on the graphics card instead of repainting the line 30 times a second
- remember volume really remembers it, it used to jump back to 80% on every start
- remember volume can start at a fixed level you pick instead of the last one
- remember queue can start playing right away, start paused, or do what it did when you closed it
- auto lyrics pick the version most sources agree on line by line, so a single late or romanized copy no longer wins
- LyricsPlus asks a second server when the first one has cached a miss, songwriter lines at the top of the lyrics are dropped
- lyrics glide to the next line again with Windows animations turned off
- downloads are saved as "artist - title [id].webm" instead of "id.audio"
- the main window opens bigger on big screens and fits a 1080p screen at 200%
- covers are sharp on high DPI screens, the blur behind dialogs is lighter
- Linux: no invisible tray icon on plain GNOME, closing quits when there is no tray to hide in, the tray icon is sharp
- Linux: global hotkeys show as unavailable on Wayland instead of pretending to work, the lyrics overlay stays clickable there
- Linux: the phone remote address can be selected and copied, the share card has no hard glow strip, one wheel notch on the volume moves 2%

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

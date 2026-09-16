# Legal notice

Zenith Player  
Effective 15 September 2026

This notice describes how the software relates to third-party services and
rights. It is not a license from Google, YouTube, or any rights holder, and it
is not legal advice.

## Status

Zenith is independent software published under the MIT License. It is not
developed, endorsed, sponsored, or certified by Google LLC, YouTube, or
YouTube Music.

The application name is Zenith / Zenith Player. Do not distribute it under a
name or appearance that suggests it is an official YouTube or Google product.

## Trademarks

YouTube, YouTube Music, Google, and related marks are owned by Google LLC or
their respective owners. They appear in the interface and documentation only
to identify the service the software communicates with.

Do not add YouTube or Google logos, wordmarks, or trade dress to this project.

## Content and copyright

Audio, video, artwork, metadata, and lyrics displayed or played through Zenith
remain the property of their owners. Zenith does not host a catalog, does not
sell or sublicense that material, and does not grant any copyright license in
it. The MIT grant in `LICENSE` applies to Zenith source code and original
assets only. See also `NOTICE.md`.

Playing a track in Zenith does not create a right to copy, redistribute, or
use that track commercially.

## YouTube and Google terms

Anyone using Zenith remains subject to:

- [YouTube Terms of Service](https://www.youtube.com/t/terms)
- [Google Terms of Service](https://policies.google.com/terms)

and any YouTube Music terms that apply to their account.

The software does not enlarge those rights. It is intended for personal
playback of material the user's own session may already access on the public
YouTube Music website. It is not a substitute for YouTube Premium and does not
offer a feature to unlock paid, private, or region-locked items beyond what
that session already permits.

If YouTube or Google disable access, or if a rights holder requires that use
stop, stop using the software.

## Operation

| Stage    | Behaviour                                                                |
| -------- | ------------------------------------------------------------------------ |
| Catalog  | Public YouTube Music InnerTube (browse, search, library, playlists)      |
| Playback | HTML audio element in the local WebView                                  |
| URL      | yt-dlp `-g` (print a URL). InnerTube `/player` if that call fails        |
| Proxy    | Loopback (`127.0.0.1`) so the WebView can fetch the URL (CORS)           |
| Cache    | Stream URLs held in RAM for a few minutes; they expire on YouTube's side |
| yt-dlp   | Downloaded into local app data at runtime; not shipped in git            |

There is no command or UI to save the media file. The loopback proxy is bound
to this machine and is not a distribution server.

YouTube may change, throttle, or withdraw the endpoints the software uses.
Continuity of playback is not guaranteed.

## Third parties

| Component               | Use                           | Notes                                            |
| ----------------------- | ----------------------------- | ------------------------------------------------ |
| YouTube Music InnerTube | Catalog; optional player URL  | Public web API; may change or be blocked         |
| yt-dlp                  | Resolve a playback URL (`-g`) | Separate project and license; not vendored       |
| Lyric providers         | Lyrics                        | LRCLib, Musixmatch, Genius, lyrics.ovh, captions |
| Discord / DualSense     | Optional plugins              | Unrelated to Google                              |

Their licenses and terms apply in addition to this notice.

## Warranty

THE SOFTWARE IS PROVIDED "AS IS", as stated in `LICENSE`. Redistributions must
keep `LICENSE`, this file, and `NOTICE.md`, and must not state or imply
affiliation with Google LLC or YouTube.

## Notices from rights holders

Send trademark, copyright, or terms-of-service complaints to the maintainer
listed on the GitHub profile, or open an issue with the prefix `legal:`.
Good-faith requests are reviewed promptly.

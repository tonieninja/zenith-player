import type { Language } from '.';

type PluginText = { name: string; desc: string };

const CATALOG: Record<string, Record<Language, PluginText>> = {
  crossfade: {
    en: { name: 'Crossfade', desc: 'Blends the end of one track into the next.' },
    pl: { name: 'Płynne przejścia', desc: 'Końcówka utworu płynnie przechodzi w następny.' },
  },
  'sleep-timer': {
    en: { name: 'Sleep timer', desc: 'Stops the music after the time you set.' },
    pl: { name: 'Wyłącznik czasowy', desc: 'Wyłącza muzykę po czasie, który ustawisz.' },
  },
  'playback-speed': {
    en: { name: 'Playback speed', desc: 'Speed it up or slow it down without changing the pitch.' },
    pl: {
      name: 'Prędkość odtwarzania',
      desc: 'Przyspiesz albo zwolnij bez zmiany wysokości dźwięku.',
    },
  },
  'discord-rpc': {
    en: { name: 'Discord presence', desc: "Shows what you're listening to on Discord." },
    pl: { name: 'Status na Discordzie', desc: 'Pokazuje na Discordzie, czego słuchasz.' },
  },
  'lyrics-overlay': {
    en: {
      name: 'Lyrics overlay',
      desc: 'A floating window with synced lyrics that stays on top. Drag it anywhere, close it with the X.',
    },
    pl: {
      name: 'Nakładka z tekstem',
      desc: 'Pływające okienko z tekstem na bieżąco, zawsze na wierzchu. Przeciągnij je, gdzie chcesz, a zamkniesz je przyciskiem X.',
    },
  },
  'second-screen-lyrics': {
    en: { name: 'Second screen lyrics', desc: 'A big lyrics window for your second monitor.' },
    pl: { name: 'Tekst na drugim ekranie', desc: 'Duże okno z tekstem na drugi monitor.' },
  },
  'mini-player': {
    en: {
      name: 'Mini player',
      desc: 'A small always-on-top window with controls, a draggable timeline, a like button and optional synced lyrics. Hide any button you do not need.',
    },
    pl: {
      name: 'Miniodtwarzacz',
      desc: 'Małe okienko zawsze na wierzchu: sterowanie, przeciągany pasek czasu, „Lubię to” i opcjonalnie tekst z karaoke. Każdy przycisk możesz ukryć.',
    },
  },
  'preload-next': {
    en: { name: 'Preload next', desc: 'Loads the next tracks in your queue ahead of time.' },
    pl: { name: 'Wczytywanie z wyprzedzeniem', desc: 'Wczytuje z góry kolejne utwory z kolejki.' },
  },
  'fade-on-pause': {
    en: { name: 'Fade on pause', desc: 'Fades the volume out when you pause.' },
    pl: { name: 'Wyciszanie przy pauzie', desc: 'Płynnie ścisza muzykę, kiedy dajesz pauzę.' },
  },
  'remote-control': {
    en: {
      name: 'Phone remote',
      desc: 'Control Zenith from your phone or any device on your network (volume, skip, seek, queue, like, search).',
    },
    pl: {
      name: 'Sterowanie przez sieć',
      desc: 'Steruj Zenith z telefonu albo innego urządzenia w sieci (głośność, przełączanie, przewijanie, kolejka, polubienia, szukanie).',
    },
  },
  equalizer: {
    en: {
      name: 'Equalizer',
      desc: '15-band graphic EQ (25 Hz to 16 kHz) with presets, including bass boost.',
    },
    pl: {
      name: 'Korektor (EQ)',
      desc: '15-pasmowy korektor graficzny (25 Hz do 16 kHz) z gotowymi ustawieniami, takimi jak wzmocnienie basu.',
    },
  },
  'lastfm-scrobbler': {
    en: {
      name: 'Last.fm scrobbler',
      desc: 'Scrobbles what you listen to on your Last.fm profile.',
    },
    pl: { name: 'Last.fm scrobbler', desc: 'Wrzuca to, czego słuchasz, na twój profil Last.fm.' },
  },
  'listenbrainz-scrobbler': {
    en: { name: 'ListenBrainz', desc: 'Sends what you listen to to your ListenBrainz profile.' },
    pl: { name: 'ListenBrainz', desc: 'Wysyła to, czego słuchasz, na twój profil ListenBrainz.' },
  },
  'loudness-normalization': {
    en: {
      name: 'Loudness normalization',
      desc: 'Evens out volume between tracks (loud ones get turned down, never up).',
    },
    pl: {
      name: 'Normalizacja głośności',
      desc: 'Wyrównuje głośność między utworami (głośne są ściszane, cichych nie podgłaśnia).',
    },
  },
  webhook: {
    en: { name: 'Webhook', desc: 'Sends a POST to your URL every time the track changes.' },
    pl: { name: 'Webhook', desc: 'Przy każdej zmianie utworu wysyła POST na podany adres URL.' },
  },
  'duck-on-voice': {
    en: { name: 'Voice ducking', desc: 'Turns the music down while you talk (uses your mic).' },
    pl: {
      name: 'Ściszanie przy mówieniu',
      desc: 'Ścisza muzykę, kiedy mówisz (korzysta z mikrofonu).',
    },
  },
  'ab-loop': {
    en: { name: 'A-B loop', desc: 'Loops any part of a track.' },
    pl: { name: 'Pętla A-B', desc: 'Zapętla wybrany fragment utworu.' },
  },
  sponsorblock: {
    en: {
      name: 'SponsorBlock',
      desc: 'Skips talking, skits and sponsor breaks in music videos, as marked by the SponsorBlock community.',
    },
    pl: {
      name: 'SponsorBlock',
      desc: 'Pomija gadanie, scenki i wstawki sponsorskie w teledyskach, oznaczone przez społeczność SponsorBlock.',
    },
  },
  'share-card': {
    en: { name: 'Share card', desc: 'Copies a nice-looking card of the current track.' },
    pl: {
      name: 'Karta udostępniania',
      desc: 'Kopiuje do schowka ładną kartę z tym, co teraz leci.',
    },
  },
  'listening-room': {
    en: {
      name: 'Listening room',
      desc: 'A local room on this computer: share the code and listen in sync.',
    },
    pl: {
      name: 'Pokój słuchania',
      desc: 'Lokalny pokój na tym komputerze: podaj kod i słuchajcie razem.',
    },
  },
  'smart-lyrics': {
    en: {
      name: 'Smart lyrics search',
      desc: "Cleans up titles (drops 'Artist -' and 'feat.') before looking up lyrics.",
    },
    pl: {
      name: 'Inteligentne szukanie tekstów',
      desc: 'Zanim poszuka tekstu, czyści tytuł (wywala „Wykonawca -” i „feat.”).',
    },
  },
  'zenith-stage': {
    en: {
      name: 'Zenith Stage',
      desc: 'For streamers: lyrics overlay and share card with one switch.',
    },
    pl: {
      name: 'Zenith Stage',
      desc: 'Pakiet dla streamerów: nakładka z tekstem i karta udostępniania jednym przełącznikiem.',
    },
  },
  'dualsense-pad': {
    en: {
      name: 'DualSense controller',
      desc: 'Control playback with touchpad swipes and buttons. The LED matches the cover.',
    },
    pl: {
      name: 'Kontroler DualSense',
      desc: 'Sterujesz muzyką gestami na touchpadzie i przyciskami, a dioda świeci w kolorze okładki.',
    },
  },
  'offline-downloads': {
    en: {
      name: 'Offline downloads',
      desc: 'Save tracks to your drive and play them without internet. Right-click a cover or a track to download, even hours-long mixes. Manage or delete them here.',
    },
    pl: {
      name: 'Pobrane offline',
      desc: 'Zapisuje utwory na dysku, żeby grały bez internetu. Pobierasz prawym przyciskiem na okładce albo utworze, nawet wielogodzinne miksy. Tutaj nimi zarządzasz i je usuwasz.',
    },
  },
  'global-hotkeys': {
    en: {
      name: 'Global hotkeys',
      desc: 'Play/pause, next, previous, volume and like from any app. You can change every combo, and ones the system already uses get skipped.',
    },
    pl: {
      name: 'Globalne skróty',
      desc: 'Play/pauza, następny, poprzedni, głośność i polubienie z każdej aplikacji. Każdy skrót możesz zmienić, a te zajęte przez system są pomijane.',
    },
  },
  'keyboard-shortcuts': {
    en: {
      name: 'Keyboard shortcuts',
      desc: 'Space play/pause, ←/→ or P/N previous/next, Shift+←/→ seek ±10 s, ↑/↓ volume, M mute.',
    },
    pl: {
      name: 'Skróty klawiszowe',
      desc: 'Spacja play/pauza, ←/→ albo P/N poprzedni/następny, Shift+←/→ przewijanie ±10 s, ↑/↓ głośność, M wyciszenie.',
    },
  },
  'queue-persist': {
    en: { name: 'Remember queue', desc: 'Brings back your queue and spot after a restart.' },
    pl: {
      name: 'Zapamiętywanie kolejki',
      desc: 'Po restarcie wracasz do tej samej kolejki i miejsca w utworze.',
    },
  },
  'remember-volume': {
    en: { name: 'Remember volume', desc: 'Keeps your volume the same next time you open the app.' },
    pl: {
      name: 'Zapamiętywanie głośności',
      desc: 'Przy następnym uruchomieniu głośność zostaje taka sama.',
    },
  },
  'auto-pause-blur': {
    en: { name: 'Pause when unfocused', desc: 'Pauses when you switch to another window.' },
    pl: {
      name: 'Pauza po utracie fokusu',
      desc: 'Pauzuje muzykę, kiedy przełączysz się na inne okno.',
    },
  },
  'ambient-glow': {
    en: { name: 'Ambient glow', desc: 'A soft glow in the colors of the cover art.' },
    pl: { name: 'Poświata z okładki', desc: 'Delikatna poświata w kolorach okładki.' },
  },
  'music-video': {
    en: {
      name: 'Music video',
      desc: 'Plays the music video in place of the cover art. The sound stays the same.',
    },
    pl: {
      name: 'Teledysk',
      desc: 'Zamiast okładki pokazuje teledysk utworu. Dźwięk się nie zmienia.',
    },
  },
  'smooth-volume': {
    en: { name: 'Smooth volume', desc: 'Volume changes gradually instead of jumping.' },
    pl: { name: 'Płynna głośność', desc: 'Głośność zmienia się płynnie, bez skoków.' },
  },
  'stats-tracker': {
    en: { name: 'Listening stats', desc: 'Keeps your listening stats on this device.' },
    pl: {
      name: 'Statystyki słuchania',
      desc: 'Zbiera statystyki słuchania, tylko na tym komputerze.',
    },
  },
  'listening-history': {
    en: { name: 'Listening history', desc: 'Keeps a list of what you played recently.' },
    pl: { name: 'Historia słuchania', desc: 'Zapisuje ostatnio słuchane utwory.' },
  },
  'media-session': {
    en: {
      name: 'Media controls',
      desc: "System 'Now playing' panel, lock screen and media keys (MPRIS on Linux).",
    },
    pl: {
      name: 'Sterowanie multimediami',
      desc: 'Systemowy panel „Teraz odtwarzane”, ekran blokady i klawisze multimedialne (MPRIS na Linuksie).',
    },
  },
  'taskbar-buttons': {
    en: {
      name: 'Taskbar buttons',
      desc: 'Previous, play/pause and next under the window preview on the taskbar. Windows only.',
    },
    pl: {
      name: 'Przyciski na pasku zadań',
      desc: 'Poprzedni, odtwórz/pauza i następny pod podglądem okna na pasku zadań. Tylko Windows.',
    },
  },
  'block-artists': {
    en: {
      name: 'Block artists',
      desc: 'Skips tracks by artists you block, also in radio and mixes.',
    },
    pl: {
      name: 'Blokowanie wykonawców',
      desc: 'Pomija utwory zablokowanych wykonawców, także w radiu i mixach.',
    },
  },
  'skip-ai-music': {
    en: {
      name: 'Skip AI music',
      desc: 'Skips tracks by artists that mainly publish AI-generated music. Uses a community list updated daily.',
    },
    pl: {
      name: 'Pomijanie muzyki AI',
      desc: 'Pomija utwory artystów, którzy wydają głównie muzykę z generatorów AI. Korzysta z listy społeczności, aktualizowanej codziennie.',
    },
  },
  'zenith-links': {
    en: {
      name: 'zenith:// links',
      desc: 'Links like zenith://play?v=<id> from the browser or other apps open in Zenith. Windows and Linux.',
    },
    pl: {
      name: 'Linki zenith://',
      desc: 'Linki w rodzaju zenith://play?v=<id> z przeglądarki albo innych programów otwierają się w Zenith. Windows i Linux.',
    },
  },
  'window-title': {
    en: { name: 'Window title', desc: "Shows what's playing in the window title." },
    pl: { name: 'Tytuł okna', desc: 'Pokazuje w tytule okna, co teraz leci.' },
  },
  'copy-track-link': {
    en: {
      name: 'Copy track link',
      desc: 'Right-click the cover in the player to copy a clean link, or one that starts at the current time.',
    },
    pl: {
      name: 'Kopiowanie linku',
      desc: 'Kliknij prawym na okładkę w odtwarzaczu i skopiuj czysty link, też od bieżącego momentu.',
    },
  },
  'system-tray': {
    en: { name: 'System tray', desc: 'Closing the window keeps Zenith playing in the tray.' },
    pl: {
      name: 'Zasobnik systemowy',
      desc: 'Po zamknięciu okna Zenith dalej gra w zasobniku systemowym.',
    },
  },
};

export function pluginText(lang: Language, id: string, fallback: PluginText): PluginText {
  return CATALOG[id]?.[lang] ?? fallback;
}

const GENRE_PL: Record<string, string> = {
  african: 'Afrykańska',
  arabic: 'Arabska',
  autumn: 'Jesień',
  blues: 'Blues',
  bollywood: 'Bollywood i Indie',
  classical: 'Klasyczna',
  country: 'Country i Americana',
  dance: 'Dance i elektroniczna',
  decades: 'Dekady',
  family: 'Dla rodziny',
  folk: 'Folk i akustyczna',
  hiphop: 'Hip-hop',
  indie: 'Indie i alternatywa',
  jpop: 'J-Pop',
  jazz: 'Jazz',
  kpop: 'K-Pop',
  latin: 'Latynoska',
  mandopop: 'Mandopop i cantopop',
  metal: 'Metal',
  pop: 'Pop',
  rnb: 'R&B i soul',
  reggae: 'Reggae i karaibska',
  rock: 'Rock',
  soundtracks: 'Ścieżki dźwiękowe i musicale',
};

export function moodLabel(
  lang: Language,
  id: string,
  fallback: string,
  t: Record<string, string>
): string {
  const keyMap: Record<string, string> = {
    chill: 'chill',
    christmas: 'christmas',
    commute: 'commute',
    energize: 'energize',
    feelgood: 'feelGood',
    focus: 'focus',
    gaming: 'gaming',
    party: 'party',
    romance: 'romance',
    sad: 'sad',
    sleep: 'sleep',
    workout: 'workout',
  };
  const key = keyMap[id];
  if (key && t[key]) return t[key];
  if (lang === 'pl' && GENRE_PL[id]) return GENRE_PL[id];
  return fallback;
}

export function getExploreLayout(title: string): 'trending' | 'videos' | 'albums' | 'carousel' {
  const tl = title.toLowerCase();
  if (
    ['trending', 'trendy', 'chart', 'charts', 'top', 'na czasie', 'przeboj'].some((k) =>
      tl.includes(k)
    )
  ) {
    return 'trending';
  }
  if (['video', 'teledysk', 'clip', 'wideo', 'teledyski'].some((k) => tl.includes(k))) {
    return 'videos';
  }
  if (['album', 'single', 'release', 'nowo', 'nowe albumy'].some((k) => tl.includes(k))) {
    return 'albums';
  }
  return 'carousel';
}

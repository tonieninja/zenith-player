import type { Language } from '../i18n';

type PluginText = { name: string; desc: string };

const CATALOG: Record<string, Record<Language, PluginText>> = {
  crossfade: {
    en: { name: 'Crossfade', desc: 'Smooth overlap between tracks.' },
    pl: { name: 'Płynne przejścia', desc: 'Płynne nakładanie się kończącego i następnego utworu.' },
  },
  'sleep-timer': {
    en: { name: 'Sleep timer', desc: 'Stop playback after a set time.' },
    pl: { name: 'Wyłącznik czasowy', desc: 'Zatrzymuje odtwarzanie po ustawionym czasie.' },
  },
  'playback-speed': {
    en: { name: 'Playback speed', desc: 'Change the tempo without changing the pitch.' },
    pl: { name: 'Prędkość odtwarzania', desc: 'Zmienia tempo bez zmiany wysokości dźwięku.' },
  },
  'discord-rpc': {
    en: { name: 'Discord presence', desc: 'Show what you are listening to on Discord.' },
    pl: { name: 'Status na Discordzie', desc: 'Pokazuje na Discordzie, czego słuchasz.' },
  },
  'lyrics-overlay': {
    en: {
      name: 'Lyrics overlay',
      desc: 'Floating, always-on-top window with synced lyrics. Drag it anywhere, close it with its X.',
    },
    pl: {
      name: 'Nakładka z tekstem',
      desc: 'Pływające okno z zsynchronizowanym tekstem, zawsze na wierzchu. Przeciągnij je w dowolne miejsce, zamknij przyciskiem X.',
    },
  },
  'second-screen-lyrics': {
    en: { name: 'Second screen lyrics', desc: 'Big lyrics window for a second monitor.' },
    pl: { name: 'Tekst na drugim ekranie', desc: 'Duże okno z tekstem na drugi monitor.' },
  },
  'lyrics-karaoke': {
    en: { name: 'Karaoke mode', desc: 'Highlight the active line with a pulse.' },
    pl: { name: 'Tryb karaoke', desc: 'Podświetla aktywną linię pulsującym efektem.' },
  },
  'mini-player': {
    en: { name: 'Mini player', desc: 'Compact always-on-top window with transport controls.' },
    pl: { name: 'Miniodtwarzacz', desc: 'Kompaktowe okno ze sterowaniem, zawsze na wierzchu.' },
  },
  'preload-next': {
    en: { name: 'Preload next', desc: 'Buffer upcoming tracks from the queue.' },
    pl: { name: 'Wczytywanie z wyprzedzeniem', desc: 'Buforuje kolejne utwory z kolejki.' },
  },
  'fade-on-pause': {
    en: { name: 'Fade on pause', desc: 'Fade the volume smoothly when pausing.' },
    pl: { name: 'Wyciszanie przy pauzie', desc: 'Płynnie ścisza dźwięk przy pauzowaniu.' },
  },
  'remote-control': {
    en: {
      name: 'Control by your internet',
      desc: 'Control Zenith from a phone or any device on your network (volume, skip, seek, queue, like, search).',
    },
    pl: {
      name: 'Sterowanie przez sieć',
      desc: 'Steruj Zenith z telefonu lub dowolnego urządzenia w sieci (głośność, przełączanie, przewijanie, kolejka, polubienia, wyszukiwanie).',
    },
  },
  equalizer: {
    en: {
      name: 'Equalizer',
      desc: '15-band graphic equalizer (25 Hz to 16 kHz) with presets, Bass Boost included.',
    },
    pl: {
      name: 'Korektor (EQ)',
      desc: '15-pasmowy korektor graficzny (25 Hz do 16 kHz) z presetami, w tym Bass Boost.',
    },
  },
  'lastfm-scrobbler': {
    en: {
      name: 'Last.fm Scrobbler',
      desc: 'Scrobbles what you listen to to your Last.fm profile.',
    },
    pl: { name: 'Last.fm Scrobbler', desc: 'Zapisuje słuchane utwory na Twoim profilu Last.fm.' },
  },
  'loudness-normalization': {
    en: {
      name: 'Loudness normalization',
      desc: 'Evens out volume between tracks (loud ones are turned down, never boosted).',
    },
    pl: {
      name: 'Normalizacja głośności',
      desc: 'Wyrównuje głośność między utworami (głośne są ściszane, nigdy podgłaśniane).',
    },
  },
  webhook: {
    en: { name: 'Webhook', desc: 'Send track changes to a URL (POST).' },
    pl: { name: 'Webhook', desc: 'Wysyła informację o zmianie utworu na podany adres URL (POST).' },
  },
  'duck-on-voice': {
    en: { name: 'Duck on voice', desc: 'Lower the music while you speak (uses the microphone).' },
    pl: {
      name: 'Ściszanie przy mówieniu',
      desc: 'Ścisza muzykę, gdy mówisz (korzysta z mikrofonu).',
    },
  },
  'ab-loop': {
    en: { name: 'A-B loop', desc: 'Repeat a section of the track.' },
    pl: { name: 'Pętla A-B', desc: 'Powtarza wybrany fragment utworu.' },
  },
  'share-card': {
    en: { name: 'Share card', desc: 'Copy a rich card of the current track.' },
    pl: { name: 'Karta udostępniania', desc: 'Kopiuje do schowka kartę z bieżącym utworem.' },
  },
  'listening-room': {
    en: {
      name: 'Listening room',
      desc: 'Local room on this machine: share a code and sync playback.',
    },
    pl: {
      name: 'Pokój słuchania',
      desc: 'Lokalny pokój na tym komputerze: udostępnij kod i słuchajcie razem.',
    },
  },
  'smart-lyrics': {
    en: {
      name: 'Smart lyrics search',
      desc: "Cleans titles (drops 'Artist -' and 'feat.') before looking up lyrics.",
    },
    pl: {
      name: 'Inteligentne szukanie tekstów',
      desc: 'Czyści tytuły (usuwa „Wykonawca -” i „feat.”) przed szukaniem tekstu.',
    },
  },
  'zenith-stage': {
    en: {
      name: 'Zenith Stage',
      desc: 'Streamer pack: lyrics overlay + karaoke + share card in one toggle.',
    },
    pl: {
      name: 'Zenith Stage',
      desc: 'Pakiet dla streamerów: nakładka z tekstem, karaoke i karta udostępniania jednym przełącznikiem.',
    },
  },
  'dualsense-pad': {
    en: {
      name: 'DualSense controller',
      desc: 'Touchpad swipes and buttons control playback; the LED follows the cover.',
    },
    pl: {
      name: 'Kontroler DualSense',
      desc: 'Gesty na touchpadzie i przyciski sterują odtwarzaniem; dioda LED przyjmuje kolor okładki.',
    },
  },
  'offline-downloads': {
    en: {
      name: 'Offline downloads',
      desc: 'Save tracks to disk and play them without internet. Manage or delete them here.',
    },
    pl: {
      name: 'Pobrane offline',
      desc: 'Zapisuje utwory na dysku i gra je bez internetu. Tutaj nimi zarządzasz i je usuwasz.',
    },
  },
  'global-hotkeys': {
    en: {
      name: 'Global hotkeys',
      desc: 'Play/pause, next, previous, volume and like from any app. Every combo can be changed; ones already taken by the system are skipped.',
    },
    pl: {
      name: 'Globalne skróty',
      desc: 'Odtwarzaj/pauza, następny, poprzedni, głośność i polubienie z dowolnej aplikacji. Każdy skrót można zmienić, a te zajęte przez system są pomijane.',
    },
  },
  'keyboard-shortcuts': {
    en: {
      name: 'Keyboard shortcuts',
      desc: 'Space play/pause, ←/→ or P/N previous/next, Shift+←/→ seek ±10 s, ↑/↓ volume, M mute.',
    },
    pl: {
      name: 'Skróty klawiszowe',
      desc: 'Spacja odtwarzaj/pauza, ←/→ lub P/N poprzedni/następny, Shift+←/→ przewijanie ±10 s, ↑/↓ głośność, M wyciszenie.',
    },
  },
  'queue-persist': {
    en: { name: 'Remember queue', desc: 'Restore the queue and position after a restart.' },
    pl: {
      name: 'Zapamiętywanie kolejki',
      desc: 'Przywraca kolejkę i pozycję po ponownym uruchomieniu.',
    },
  },
  'remember-volume': {
    en: { name: 'Remember volume', desc: 'Keep the volume between sessions.' },
    pl: { name: 'Zapamiętywanie głośności', desc: 'Zachowuje głośność między sesjami.' },
  },
  'auto-pause-blur': {
    en: { name: 'Pause when unfocused', desc: 'Pause when the app loses focus.' },
    pl: {
      name: 'Pauza po utracie fokusu',
      desc: 'Wstrzymuje odtwarzanie, gdy okno aplikacji traci fokus.',
    },
  },
  'ambient-glow': {
    en: { name: 'Ambient glow', desc: 'Subtle glow taken from the cover art.' },
    pl: { name: 'Poświata z okładki', desc: 'Delikatna poświata w kolorach okładki.' },
  },
  'smooth-volume': {
    en: { name: 'Smooth volume', desc: 'Gradual volume changes.' },
    pl: { name: 'Płynna głośność', desc: 'Stopniowe zmiany głośności.' },
  },
  'stats-tracker': {
    en: { name: 'Listening stats', desc: 'Keep listening statistics locally.' },
    pl: { name: 'Statystyki słuchania', desc: 'Zapisuje lokalnie statystyki słuchania.' },
  },
  'listening-history': {
    en: { name: 'Listening history', desc: 'Log recently played tracks.' },
    pl: { name: 'Historia słuchania', desc: 'Zapisuje ostatnio odtwarzane utwory.' },
  },
  'media-session': {
    en: {
      name: 'Media controls',
      desc: "System 'Now playing' panel, lock screen and media keys (MPRIS on Linux).",
    },
    pl: {
      name: 'Sterowanie multimediami',
      desc: 'Systemowy panel „Teraz odtwarzane”, ekran blokady i klawisze multimedialne (MPRIS w Linuksie).',
    },
  },
  'window-title': {
    en: { name: 'Window title', desc: 'Show the current track in the window title.' },
    pl: { name: 'Tytuł okna', desc: 'Pokazuje bieżący utwór w tytule okna.' },
  },
  'copy-track-link': {
    en: { name: 'Copy track link', desc: 'Copy the YouTube Music link of the track.' },
    pl: { name: 'Kopiowanie linku', desc: 'Kopiuje link do utworu w YouTube Music.' },
  },
  'system-tray': {
    en: { name: 'System tray', desc: 'Closing the window keeps Zenith playing in the tray.' },
    pl: {
      name: 'Zasobnik systemowy',
      desc: 'Zamknięcie okna zostawia Zenith grający w zasobniku systemowym.',
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

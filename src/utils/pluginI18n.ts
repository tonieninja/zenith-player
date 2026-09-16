import type { Language } from '../i18n';

type PluginText = { name: string; desc: string };

const CATALOG: Record<string, Record<Language, PluginText>> = {
  crossfade: {
    en: { name: 'Crossfade', desc: 'Smooth overlap between tracks.' },
    pl: { name: 'Crossfade', desc: 'Płynne nakładanie się utworów.' },
  },
  'sleep-timer': {
    en: { name: 'Sleep timer', desc: 'Stop playback after a set time.' },
    pl: { name: 'Timer snu', desc: 'Zatrzymuje odtwarzanie po czasie.' },
  },
  'playback-speed': {
    en: { name: 'Playback speed', desc: 'Change tempo without pitch shift.' },
    pl: { name: 'Prędkość odtwarzania', desc: 'Zmienia tempo bez zmiany wysokości.' },
  },
  'discord-rpc': {
    en: { name: 'Discord presence', desc: 'Show what you listen to on Discord.' },
    pl: { name: 'Discord Rich Presence', desc: 'Pokazuje co słuchasz na Discordzie.' },
  },
  'lyrics-overlay': {
    en: { name: 'Lyrics overlay', desc: 'Floating synced lyrics on screen.' },
    pl: { name: 'Overlay tekstów', desc: 'Pływające zsynchronizowane teksty.' },
  },
  'second-screen-lyrics': {
    en: { name: 'Second screen lyrics', desc: 'Dedicated lyrics window.' },
    pl: { name: 'Tekst na drugim ekranie', desc: 'Osobne okno z tekstem.' },
  },
  'lyrics-karaoke': {
    en: { name: 'Karaoke mode', desc: 'Highlight active line with pulse.' },
    pl: { name: 'Tryb karaoke', desc: 'Podświetla aktywną linię z pulsem.' },
  },
  'mini-player': {
    en: { name: 'Mini player', desc: 'Compact always-on-top window.' },
    pl: { name: 'Mini player', desc: 'Kompaktowe okno zawsze na wierzchu.' },
  },
  'preload-next': {
    en: { name: 'Preload next', desc: 'Buffer upcoming queue tracks.' },
    pl: { name: 'Preload następnego', desc: 'Buforuje kolejne utwory z kolejki.' },
  },
  'fade-on-pause': {
    en: { name: 'Fade on pause', desc: 'Smooth fade when pausing.' },
    pl: { name: 'Fade przy pauzie', desc: 'Płynne wyciszanie przy pauzie.' },
  },
  webhook: {
    en: { name: 'Webhook', desc: 'POST track changes to a URL.' },
    pl: { name: 'Webhook', desc: 'Wysyła zmiany utworu na URL.' },
  },
  'duck-on-voice': {
    en: { name: 'Duck on voice', desc: 'Lower music while you speak.' },
    pl: { name: 'Duck przy głosie', desc: 'Ścisza muzykę gdy mówisz.' },
  },
  'ab-loop': {
    en: { name: 'A-B loop', desc: 'Repeat a section of the track.' },
    pl: { name: 'Pętla A-B', desc: 'Powtarza fragment utworu.' },
  },
  'share-card': {
    en: { name: 'Share card', desc: 'Copy a rich track card.' },
    pl: { name: 'Karta udostępniania', desc: 'Kopiuje kartę utworu.' },
  },
  'listening-room': {
    en: {
      name: 'Listening room',
      desc: 'Local room on this machine: share a code and sync playback.',
    },
    pl: {
      name: 'Pokój słuchania',
      desc: 'Lokalny pokój na tym komputerze: kod i wspólne odtwarzanie.',
    },
  },
  'smart-lyrics': {
    en: {
      name: 'Smart Lyrics Search',
      desc: 'Cleans titles (drops Artist - / feat.) before lyrics lookup.',
    },
    pl: {
      name: 'Smart Lyrics Search',
      desc: 'Czyści tytuły (Artist - / feat.) przed szukaniem tekstów.',
    },
  },
  'zenith-stage': {
    en: {
      name: 'Zenith Stage',
      desc: 'Streamer pack: overlay + karaoke + share card.',
    },
    pl: {
      name: 'Zenith Stage',
      desc: 'Pakiet streamera: overlay + karaoke + karta.',
    },
  },
  'dualsense-pad': {
    en: {
      name: 'DualSense Pad',
      desc: 'Touchpad swipes and buttons control playback; LED follows cover.',
    },
    pl: {
      name: 'DualSense Pad',
      desc: 'Gesty touchpada i przyciski sterują odtwarzaniem; LED z okładki.',
    },
  },
  'global-hotkeys': {
    en: { name: 'Global hotkeys', desc: 'Media keys work system-wide.' },
    pl: { name: 'Globalne skróty', desc: 'Klawisze mediów działają globalnie.' },
  },
  'keyboard-shortcuts': {
    en: { name: 'Keyboard shortcuts', desc: 'In-app shortcuts for playback.' },
    pl: { name: 'Skróty klawiszowe', desc: 'Skróty odtwarzania w aplikacji.' },
  },
  'queue-persist': {
    en: { name: 'Queue persist', desc: 'Restore queue after restart.' },
    pl: { name: 'Zapis kolejki', desc: 'Przywraca kolejkę po restarcie.' },
  },
  'remember-volume': {
    en: { name: 'Remember volume', desc: 'Keep volume between sessions.' },
    pl: { name: 'Zapamiętaj głośność', desc: 'Zachowuje głośność między sesjami.' },
  },
  'auto-pause-blur': {
    en: { name: 'Pause on blur', desc: 'Pause when app loses focus.' },
    pl: { name: 'Pauza przy blur', desc: 'Pauzuje gdy aplikacja traci fokus.' },
  },
  'ambient-glow': {
    en: { name: 'Ambient glow', desc: 'Subtle glow from cover art.' },
    pl: { name: 'Ambient glow', desc: 'Delikatna poświata z okładki.' },
  },
  'smooth-volume': {
    en: { name: 'Smooth volume', desc: 'Gradual volume changes.' },
    pl: { name: 'Płynna głośność', desc: 'Stopniowe zmiany głośności.' },
  },
  'stats-tracker': {
    en: { name: 'Stats tracker', desc: 'Track listening stats locally.' },
    pl: { name: 'Statystyki', desc: 'Lokalne statystyki słuchania.' },
  },
  'listening-history': {
    en: { name: 'Listening history', desc: 'Log recently played tracks.' },
    pl: { name: 'Historia', desc: 'Zapisuje ostatnio grane utwory.' },
  },
  'media-session': {
    en: {
      name: 'Media Session',
      desc: 'OS Now Playing / lock screen and media keys.',
    },
    pl: {
      name: 'Media Session',
      desc: 'Now Playing systemu / ekran blokady i klawisze mediów.',
    },
  },
  'window-title': {
    en: { name: 'Window title', desc: 'Show track in title bar.' },
    pl: { name: 'Tytuł okna', desc: 'Pokazuje utwór w pasku tytułu.' },
  },
  'copy-track-link': {
    en: { name: 'Copy track link', desc: 'Copy YouTube Music URL.' },
    pl: { name: 'Kopiuj link', desc: 'Kopiuje link YouTube Music.' },
  },
  'system-tray': {
    en: { name: 'System tray', desc: 'Minimize to tray icon.' },
    pl: { name: 'Zasobnik systemowy', desc: 'Minimalizacja do traya.' },
  },
};

export function pluginText(lang: Language, id: string, fallback: PluginText): PluginText {
  return CATALOG[id]?.[lang] ?? fallback;
}

export function moodLabel(
  _lang: Language,
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

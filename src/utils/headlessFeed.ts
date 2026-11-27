import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { LyricsResult, Track } from '../api/youtube';
import { FAVORITES_MAX, persistFavorites, readSavedTracks } from './favorites';

/** Utwór i zegar od Rusta, gdy okno główne jest zwolnione w zasobniku. */
export interface HeadlessNow {
  track: Track;
  t: number;
  d: number | null;
  playing: boolean;
  rate: number;
}

export function listenHeadless(cb: (now: HeadlessNow) => void) {
  return listen<HeadlessNow>('zenith-headless-now', (e) => {
    if (e.payload?.track?.id) cb(e.payload);
  });
}

type YoutubeApi = typeof import('../api/youtube');
let api: Promise<YoutubeApi> | null = null;

// moduł API ładujemy dopiero bez okna głównego; zwykle to ono przysyła gotowy tekst
function youtubeApi(): Promise<YoutubeApi> {
  api ??= import('../api/youtube').then(async (m) => {
    const cfg = await invoke<{ clientVersion?: string; apiKey?: string } | null>(
      'get_innertube_config'
    ).catch(() => null);
    if (cfg) m.applyInnertubeConfig(cfg);
    return m;
  });
  return api;
}

const lang = () => (localStorage.getItem('zenith_lang') === 'pl' ? 'pl' : 'en');

// klucz bez przedrostka zenith, żeby tekst nie trafiał do kopii ustawień na dysku
const SHARED = 'zh_headless_lyrics';

function readShared(id: string): LyricsResult | null | undefined {
  try {
    const s = JSON.parse(localStorage.getItem(SHARED) || 'null') as {
      id: string;
      res: LyricsResult | null;
    } | null;
    return s?.id === id ? s.res : undefined;
  } catch {
    return undefined;
  }
}

export async function headlessLyrics(now: HeadlessNow): Promise<LyricsResult | null> {
  const id = now.track.id;
  // mini i nakładka pytają o ten sam utwór: pod blokadą pobiera pierwsze okno, drugie czyta gotowy wynik
  const run = async (): Promise<LyricsResult | null> => {
    const known = readShared(id);
    if (known !== undefined) return known;
    const m = await youtubeApi();
    const track =
      !now.track.durationSec && now.d ? { ...now.track, durationSec: now.d } : now.track;
    const res = await m.getLyrics(track, lang(), 'Auto').catch(() => null);
    try {
      localStorage.setItem(SHARED, JSON.stringify({ id, res }));
    } catch {
      /* pełny localStorage: drugie okno pobierze tekst samo */
    }
    return res;
  };
  return navigator.locks ? navigator.locks.request('zenith-headless-lyrics', run) : run();
}

const FAVS = 'zenith_saved_tracks';

export function isFavorite(id: string): boolean {
  return readSavedTracks(localStorage.getItem(FAVS)).some((t) => t.id === id);
}

/** Polubienie bez okna głównego: te same ulubione co w aplikacji i ocena w YouTube Music, gdy jest sesja. */
export async function headlessToggleLike(track: Track, want?: boolean): Promise<boolean> {
  const list = readSavedTracks(localStorage.getItem(FAVS));
  // mini zna też polubienie z konta, którego nie ma w lokalnych ulubionych; bez tego nie dałoby się go zdjąć
  const liked = want ?? !list.some((t) => t.id === track.id);
  const saved: Track = {
    id: track.id,
    type: 'track',
    title: track.title,
    artist: track.artist,
    cover: track.cover,
    coverSmall: track.coverSmall,
    coverLarge: track.coverLarge,
  };
  const rest = list.filter((t) => t.id !== track.id);
  const next = liked ? [saved, ...rest] : rest;
  const body = JSON.stringify(next.slice(0, FAVORITES_MAX));
  localStorage.setItem(FAVS, body);
  persistFavorites(body);
  // z tabeli ocen czytają gust, inteligentna kolejka i odkrywanie, a nie z listy ulubionych
  void invoke('db_rate', {
    videoId: track.id,
    rating: liked ? 1 : 0,
    title: track.title,
    artist: track.artist,
  }).catch(() => undefined);
  const m = await youtubeApi();
  // bez zalogowania ocena się nie uda, a ulubione i tak zostają zapisane
  await m.setTrackRating(track.id, liked ? 'LIKE' : 'INDIFFERENT', lang()).catch(() => undefined);
  return liked;
}

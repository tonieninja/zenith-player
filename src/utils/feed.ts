import type { HomeChip, Section, Track } from '../api/youtube';

export type FeedItemIdentity = { id: string; type: Track['type'] };

export type ResolveFeedItemInput = {
  videoId?: string | null;
  browseId?: string | null;
  pageType?: string | null;
  subtitle?: string | null;
  primaryIsBrowse?: boolean;
};

export function resolveFeedItem(input: ResolveFeedItemInput): FeedItemIdentity | null {
  const videoId = input.videoId || undefined;
  let browseId = input.browseId || undefined;
  if (browseId?.startsWith('MPLAUC')) browseId = browseId.slice(4);
  const pageType = (input.pageType || '').toUpperCase();
  const sub = (input.subtitle || '').toLowerCase();
  const primaryIsBrowse = input.primaryIsBrowse ?? Boolean(browseId && !videoId);

  if (
    browseId &&
    (pageType === 'MUSIC_PAGE_TYPE_ARTIST' ||
      pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL' ||
      (primaryIsBrowse &&
        browseId.startsWith('UC') &&
        !pageType.includes('ALBUM') &&
        !pageType.includes('PLAYLIST')))
  ) {
    const profile = pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL' || /\b(profile|profil)\b/.test(sub);
    return { id: browseId, type: profile ? 'profile' : 'artist' };
  }

  // MPED to strona odcinka z id filmu w środku; jako „album” otworzyłaby pustą stronę zamiast grać
  if (browseId?.startsWith('MPED')) return { id: videoId || browseId.slice(4), type: 'track' };

  if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' && browseId) {
    return { id: browseId, type: 'album' };
  }
  if ((pageType === 'MUSIC_PAGE_TYPE_PLAYLIST' || pageType.includes('PODCAST')) && browseId) {
    return { id: browseId, type: pageType.includes('PODCAST') ? 'podcast' : 'playlist' };
  }

  if (browseId && (browseId.startsWith('MPREb') || browseId.startsWith('OLAK5uy'))) {
    return { id: browseId, type: 'album' };
  }
  if (browseId) {
    const mixId = browseId.startsWith('VL') ? browseId.slice(2) : browseId;
    if (mixId.startsWith('RD')) return { id: browseId, type: 'playlist' };
  }
  if (
    browseId &&
    primaryIsBrowse &&
    (browseId.startsWith('VL') || browseId.startsWith('PL') || browseId.startsWith('MPSP'))
  ) {
    return { id: browseId, type: 'playlist' };
  }

  if (videoId) return { id: videoId, type: 'track' };

  if (!browseId) return null;
  if (browseId.startsWith('VL') || browseId.startsWith('PL') || browseId.startsWith('MPSP')) {
    return { id: browseId, type: 'playlist' };
  }
  if (browseId.startsWith('UC')) {
    const profile = /\b(profile|profil)\b/.test(sub);
    return { id: browseId, type: profile ? 'profile' : 'artist' };
  }
  if (browseId.startsWith('MPSPP') || browseId.startsWith('MPPL')) {
    return { id: browseId, type: 'playlist' };
  }
  return { id: browseId, type: 'album' };
}

const BYLINE_TYPE_WORDS = new Set([
  'Utwór',
  'Film',
  'Wideo',
  'Video',
  'Audio',
  'Song',
  'Album',
  'Single',
  'Singiel',
  'EP',
  'Playlist',
  'Playlista',
  'Podcast',
  'Episode',
  'Odcinek',
]);

export function bylineFromRuns(runs: { text?: unknown }[]): string {
  return tidyByline(
    (runs || [])
      .map((x) => String(x?.text ?? ''))
      .join('')
      .split('•')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter((part) => part && !BYLINE_TYPE_WORDS.has(part))
      .join(' • ')
  );
}

// licznik odsłuchań i czas z kafelka to nie wykonawca, a trafiłyby do MediaSession, Discorda i scrobbli
const STAT_PART =
  /^(?:\d[\d.,\s]*\s*(?:[KMB]|tys\.|mln|mld)?\s*(?:plays?|views?|odtworze\p{L}*|wyświetle\p{L}*)|no views|\d{1,2}(?::\d{2}){1,2}|\d+\s*min(?:\s*\d+\s*s(?:ec)?)?|\d+\s*s(?:ec)?)$/iu;

export function tidyByline(artist: string): string {
  if (!artist.includes('•')) return artist;
  const parts = artist
    .replace(/\s*•\s*,\s*•\s*/g, ', ')
    .replace(/\s*•\s*([&/+])\s*•\s*/g, ' $1 ')
    .split(' • ');
  const kept = parts.filter((part) => !STAT_PART.test(part.trim()));
  return (kept.length ? kept : parts).join(' • ');
}

type BylineRun = {
  text?: unknown;
  navigationEndpoint?: { browseEndpoint?: { browseId?: unknown } };
};

// pierwszy wykonawca (UC…) i album (MPRE…) z runów bylinu, żeby dało się otworzyć ich strony
export function refsFromRuns(runs: BylineRun[]): Pick<Track, 'artistId' | 'albumId' | 'album'> {
  const out: Pick<Track, 'artistId' | 'albumId' | 'album'> = {};
  for (const run of runs || []) {
    const id = run?.navigationEndpoint?.browseEndpoint?.browseId;
    if (typeof id !== 'string') continue;
    if (!out.artistId && id.startsWith('UC')) out.artistId = id;
    else if (!out.albumId && id.startsWith('MPRE')) {
      out.albumId = id;
      const name = String(run.text ?? '').trim();
      if (name) out.album = name;
    }
  }
  return out;
}

export function stableOrderSections(sections: Section[]): Section[] {
  const seen = new Set<string>();
  return sections.filter((section) => {
    const key = section.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Półki o tym samym tytule podmienia w miejscu, nowe dokleja na końcu; bez zmian zwraca tę samą tablicę. */
export function upsertSections(cur: Section[], incoming: Section[]): Section[] {
  const at = new Map(cur.map((s, i) => [s.title, i]));
  const next = [...cur];
  let changed = false;
  for (const s of incoming) {
    const i = at.get(s.title);
    if (i === undefined) {
      at.set(s.title, next.length);
      next.push(s);
      changed = true;
    } else if (next[i] !== s) {
      next[i] = s;
      changed = true;
    }
  }
  return changed ? next : cur;
}

export const QUICK_PICKS_SHELF = 'quick-picks';

// shortcut: półka bez „Więcej” ma klucz z tytułu, bo shelfId YTM jest losowy, więc po zmianie języka wraca;
// zmienić, gdy YTM da stały identyfikator półki
export const shelfKey = (s: Section) =>
  s.id ??
  // params odróżniają półki z jednym celem, np. kategorie nastrojów
  (s.more
    ? `${s.more.browseId}${s.more.params ? `::${s.more.params}` : ''}`
    : s.title.toLowerCase().trim());

const HIDDEN_SHELVES_KEY = 'zenith_home_hidden';
// Szybki wybór miał kiedyś klucz z przetłumaczonego tytułu
const OLD_QUICK_PICKS_KEYS = ['quick picks', 'szybki wybór'];

export function loadHiddenShelves(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_SHELVES_KEY) || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    for (const old of OLD_QUICK_PICKS_KEYS) {
      if (!(old in v)) continue;
      v[QUICK_PICKS_SHELF] = v[old];
      delete v[old];
    }
    return v;
  } catch {
    return {};
  }
}

export function saveHiddenShelves(hidden: Record<string, string>) {
  try {
    if (Object.keys(hidden).length)
      localStorage.setItem(HIDDEN_SHELVES_KEY, JSON.stringify(hidden));
    else localStorage.removeItem(HIDDEN_SHELVES_KEY);
  } catch {
    /* bez zapisu ukrycie działa do końca sesji */
  }
}

export interface HomeSnapshot {
  key: string;
  sections: Section[];
  quickPicks: Track[];
  chips: HomeChip[];
}

const HOME_SNAPSHOT_KEY = 'zenith_home_cache_v1';

export function saveHomeSnapshot(snap: HomeSnapshot) {
  try {
    const sections = snap.sections.slice(0, 8).map((s) => ({ ...s, items: s.items.slice(0, 12) }));
    localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify({ ...snap, sections }));
  } catch {
    /* pełny localStorage: start pokaże splash do odpowiedzi sieci, jak bez migawki */
  }
}

/** Ostatnia Główna dla tego języka i stanu logowania, żeby start nie czekał na sieć. */
export function loadHomeSnapshot(key: string): HomeSnapshot | null {
  try {
    const v = JSON.parse(localStorage.getItem(HOME_SNAPSHOT_KEY) || 'null');
    const ok =
      v?.key === key &&
      Array.isArray(v.sections) &&
      Array.isArray(v.quickPicks) &&
      Array.isArray(v.chips);
    return ok ? v : null;
  } catch {
    return null;
  }
}

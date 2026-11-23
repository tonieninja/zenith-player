import type { Section, Track } from '../api/youtube';

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

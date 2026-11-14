import type { Track } from '../api/youtube';
import type { Section } from '../api/youtube';

export type FeedItemIdentity = { id: string; type: Track['type'] };

export type ResolveFeedItemInput = {
  videoId?: string | null;
  browseId?: string | null;
  pageType?: string | null;
  subtitle?: string | null;
  primaryIsBrowse?: boolean;
};

export function extractBrowsePageType(endpoint: unknown): string | undefined {
  const pt = (endpoint as any)?.browseEndpoint?.browseEndpointContextSupportedConfigs
    ?.browseEndpointContextMusicConfig?.pageType;
  return typeof pt === 'string' && pt ? pt : undefined;
}

export function pickRendererPageType(renderer: any): string | undefined {
  const spots = [
    renderer?.navigationEndpoint,
    renderer?.title?.runs?.[0]?.navigationEndpoint,
    renderer?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
      ?.navigationEndpoint,
    renderer?.doubleTapCommand,
    renderer,
  ];
  for (const spot of spots) {
    const pt = extractBrowsePageType(spot);
    if (pt) return pt;
  }
  return undefined;
}

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
  'Playlist',
]);

export function bylineFromRuns(runs: any[]): string {
  return tidyByline(
    (runs || [])
      .map((x: any) => String(x?.text ?? ''))
      .join('')
      .split('•')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter((part) => part && !BYLINE_TYPE_WORDS.has(part))
      .join(' • ')
  );
}

export function tidyByline(artist: string): string {
  if (!artist.includes('•')) return artist;
  return artist.replace(/\s*•\s*,\s*•\s*/g, ', ').replace(/\s*•\s*([&/+])\s*•\s*/g, ' $1 ');
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

import type { Track } from '../api/youtube';

export type FeedItemIdentity = { id: string; type: Track['type'] };

export type ResolveFeedItemInput = {
  videoId?: string | null;
  browseId?: string | null;
  pageType?: string | null;
  subtitle?: string | null;
  /** true when the row's own navigationEndpoint is a browse (not a subtitle artist chip) */
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
    const profile =
      pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL' || /\b(profile|profil)\b/.test(sub);
    return { id: browseId, type: profile ? 'profile' : 'artist' };
  }

  if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' && browseId) {
    return { id: browseId, type: 'album' };
  }
  if (
    (pageType === 'MUSIC_PAGE_TYPE_PLAYLIST' || pageType.includes('PODCAST')) &&
    browseId
  ) {
    return { id: browseId, type: pageType.includes('PODCAST') ? 'podcast' : 'playlist' };
  }

  // album / playlist cards often carry an overlay videoId for the first track;
  // keep the browse target when the id itself says what this row is
  if (browseId && (browseId.startsWith('MPREb') || browseId.startsWith('OLAK5uy'))) {
    return { id: browseId, type: 'album' };
  }
  if (
    browseId &&
    primaryIsBrowse &&
    (browseId.startsWith('VL') || browseId.startsWith('PL') || browseId.startsWith('MPSP'))
  ) {
    return { id: browseId, type: 'playlist' };
  }

  // overlay/watch videoId must not win over a missing type when this is a song row
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

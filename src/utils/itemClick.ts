import type { Track } from '../api/youtube';

export const BROWSE_MOOD_PREFIX = 'browse:';

export type ItemClickKind = 'play-track' | 'browse-page' | 'play-collection';

export function isBrowseMood(activeMood: string | null | undefined): boolean {
  return !!activeMood?.startsWith(BROWSE_MOOD_PREFIX);
}

export function browseMoodId(itemId: string): string {
  return `${BROWSE_MOOD_PREFIX}${itemId}`;
}

export function browseIdFromMood(activeMood: string | null | undefined): string | null {
  if (!activeMood?.startsWith(BROWSE_MOOD_PREFIX)) return null;
  return activeMood.slice(BROWSE_MOOD_PREFIX.length) || null;
}

/** sidebar playlists and podcasts open their page instead of starting playback */
export function sidebarClickPlan(track: Pick<Track, 'id' | 'type'>): { kind: ItemClickKind } {
  if (track.type === 'playlist' || track.type === 'podcast') {
    return { kind: 'browse-page' };
  }
  return itemClickPlan(track);
}

/** click plan: artist/profile/album open a browse page; playlists play; songs play */
export function itemClickPlan(track: Pick<Track, 'id' | 'type'>): { kind: ItemClickKind } {
  if (track.type === 'artist' || track.type === 'profile' || track.type === 'album') {
    return { kind: 'browse-page' };
  }
  if (track.type === 'playlist' || track.type === 'podcast') {
    return { kind: 'play-collection' };
  }
  if (track.type === 'track' || /^[\w-]{11}$/.test(track.id)) return { kind: 'play-track' };
  return { kind: 'play-collection' };
}

export function shouldOpenCollection(track: Pick<Track, 'id' | 'type'>): boolean {
  const kind = itemClickPlan(track).kind;
  return kind === 'browse-page' || kind === 'play-collection';
}

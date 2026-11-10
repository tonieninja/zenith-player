import { toPlainPlaylistId, type Track } from '../api/youtube';
import { isPlaceholderCover } from './covers';

export function isVideoTrackId(id: string | undefined): boolean {
  return !!id && /^[\w-]{11}$/.test(id);
}

export function isPrimaryButton(button: number | undefined): boolean {
  return (button ?? 0) === 0;
}

export function ctxTrackAttr(
  item: Pick<Track, 'id' | 'title' | 'artist' | 'cover'> & { type?: Track['type'] }
): string | undefined {
  if (!isVideoTrackId(item.id)) return undefined;
  if (item.type && item.type !== 'track') return undefined;
  return JSON.stringify({
    id: item.id,
    type: 'track',
    title: item.title,
    artist: item.artist,
    cover: item.cover,
  });
}

export function parseCtxTrackAttr(raw: string | undefined | null): Track | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === 'string') {
      return isVideoTrackId(value)
        ? { id: value, type: 'track', title: '', artist: '', cover: '' }
        : null;
    }
    if (value && typeof value === 'object' && typeof (value as Track).id === 'string') {
      const track = value as Track;
      if (!isVideoTrackId(track.id)) return null;
      return {
        id: track.id,
        type: 'track',
        title: typeof track.title === 'string' ? track.title : '',
        artist: typeof track.artist === 'string' ? track.artist : '',
        cover: typeof track.cover === 'string' ? track.cover : '',
      };
    }
  } catch {
    if (isVideoTrackId(raw)) {
      return { id: raw, type: 'track', title: '', artist: '', cover: '' };
    }
  }
  return null;
}

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

export function isViewingPlaylist(
  activeTab: string,
  activeMood: string | null | undefined,
  playlistId: string
): boolean {
  if (activeTab !== 'mood') return false;
  const openId = browseIdFromMood(activeMood);
  if (!openId) return false;
  return toPlainPlaylistId(openId) === toPlainPlaylistId(playlistId);
}

export function sidebarClickPlan(track: Pick<Track, 'id' | 'type'>): { kind: ItemClickKind } {
  if (track.type === 'playlist' || track.type === 'podcast') {
    return { kind: 'browse-page' };
  }
  return itemClickPlan(track);
}

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

// strona albumu nie podaje wykonawcy ani okładek przy utworach, więc bierzemy je z wyniku, który kliknięto
export function withCollectionMeta(
  collection: Track,
  items: Track[],
  variousArtists: string
): Track[] {
  const album = collection.type === 'album';
  const albumArtist = album
    ? ((collection.artist || '')
        .split(' • ')
        .map((x) => x.trim())
        .find((x) => x && !/^\d{4}$/.test(x) && !/^(album|single|singiel|ep)$/i.test(x)) ?? '')
    : '';
  // w albumie miniatura wideo to ta sama okładka w kadrze 4:3 z pasami, kwadrat z wyniku wygląda lepiej
  const swap = (url: string | undefined) =>
    !url || isPlaceholderCover(url) || (album && url.includes('i.ytimg.com/vi/'));
  return items.map((i) => ({
    ...i,
    artist: albumArtist && i.artist === variousArtists ? albumArtist : i.artist,
    cover: swap(i.cover) && collection.cover ? collection.cover : i.cover,
    coverSmall: swap(i.coverSmall) && collection.coverSmall ? collection.coverSmall : i.coverSmall,
    coverLarge: swap(i.coverLarge) && collection.coverLarge ? collection.coverLarge : i.coverLarge,
  }));
}

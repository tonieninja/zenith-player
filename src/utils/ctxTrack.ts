import type { Track } from '../api/youtube';

export function isVideoTrackId(id: string | undefined): boolean {
  return !!id && /^[\w-]{11}$/.test(id);
}

/** serialized track for the right-click "Add to playlist" menu */
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

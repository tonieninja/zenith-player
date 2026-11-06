import type { Track } from '../api/youtube';

export function isVideoTrackId(id: string | undefined): boolean {
  return !!id && /^[\w-]{11}$/.test(id);
}

/** true for a real left click; right-click must not also activate the card */
export function isPrimaryButton(button: number | undefined): boolean {
  return (button ?? 0) === 0;
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

/** read the payload back from data-ctx-track, including a bare video id */
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

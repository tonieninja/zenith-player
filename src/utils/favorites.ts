import type { Track } from '../api/youtube';
import { tidyByline } from './feed';
import { invoke } from '@tauri-apps/api/core';

export function readSavedTracks(raw: string | null): Track[] {
  try {
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (x): x is Track =>
          Boolean(x) && typeof x.id === 'string' && x.id.length > 0 && typeof x.title === 'string'
      )
      .map((x) => ({ ...x, artist: tidyByline(String(x.artist || '')) }));
  } catch {
    return [];
  }
}

export function mergeFavoriteTracks(local: Track[], account: Track[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const track of [...local, ...account]) {
    if (!track?.id || seen.has(track.id)) continue;
    if (track.type && track.type !== 'track') continue;
    seen.add(track.id);
    out.push(track.type ? track : { ...track, type: 'track' });
  }
  return out;
}

const KEY = 'zenith_saved_tracks';

export async function initFavoritesStore(): Promise<void> {
  try {
    const disk = await invoke<string>('favorites_load');
    const fromDisk = readSavedTracks(disk);
    const local = readSavedTracks(localStorage.getItem(KEY));
    if (local.length === 0 && fromDisk.length > 0) {
      localStorage.setItem(KEY, JSON.stringify(fromDisk));
    } else if (local.length > 0 && fromDisk.length === 0) {
      await invoke('favorites_save', { body: JSON.stringify(local.slice(0, 500)) });
    }
  } catch (err) {
    console.debug('favorites initFavoritesStore', err);
  }
}

export function persistFavorites(tracksJson: string) {
  void invoke('favorites_save', { body: tracksJson }).catch((err) =>
    console.debug('favorites persistFavorites', err)
  );
}

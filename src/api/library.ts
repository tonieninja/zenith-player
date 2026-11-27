import { invoke } from '@tauri-apps/api/core';
import type { Track } from './youtube';

export interface Collection {
  id: number;
  name: string;
  folder: string;
  count: number;
}

export const trackIn = (t: Track) => ({
  id: t.id,
  title: t.title,
  artist: t.artist,
  album: t.album ?? null,
  durationSec: t.durationSec ?? null,
  cover: t.coverSmall || t.cover || null,
});

export const listCollections = () => invoke<Collection[]>('lib_collections').catch(() => []);

export const addToCollection = (id: number, t: Track) =>
  invoke('lib_collection_add', { id, track: trackIn(t) });

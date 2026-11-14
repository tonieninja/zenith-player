import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Track } from '../api/youtube';
import { ZenithPlugin } from './types';

export interface DownloadEntry {
  id: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  duration: number;
  size: number;
  savedAt: number;
}

export interface DownloadProgress {
  id: string;
  done: number;
  total: number;
  finished?: boolean;
}

export function listDownloads(): Promise<DownloadEntry[]> {
  return invoke<DownloadEntry[]>('downloads_list').catch(() => []);
}

export function downloadTrack(t: Track, duration = 0): Promise<DownloadEntry> {
  return invoke<DownloadEntry>('downloads_add', {
    meta: {
      id: t.id,
      title: t.title,
      artist: (t.artist || '').split(' • ')[0],
      album: '',
      cover: t.coverLarge || t.cover || '',
      duration,
      size: 0,
      savedAt: 0,
    },
  });
}

export function deleteDownload(id: string): Promise<void> {
  return invoke<void>('downloads_delete', { id });
}

export function clearDownloads(): Promise<number> {
  return invoke<number>('downloads_clear');
}

export function onDownloadProgress(cb: (p: DownloadProgress) => void): () => void {
  let un: (() => void) | null = null;
  let dead = false;
  listen<DownloadProgress>('download-progress', (e) => cb(e.payload))
    .then((fn) => {
      if (dead) fn();
      else un = fn;
    })
    .catch((err) => console.debug('offlineDownloads onDownloadProgress', err));
  return () => {
    dead = true;
    un?.();
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function entryToTrack(d: DownloadEntry): Track {
  return { id: d.id, type: 'track', title: d.title, artist: d.artist, cover: d.cover };
}

export const offlineDownloadsPlugin: ZenithPlugin = {
  id: 'offline-downloads',
  name: 'Offline downloads',
  category: 'playback',
  description: 'Save tracks to disk and play them without internet.',
  defaultEnabled: false,
};

import { NowPlayingInfo, ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_listening_history';
const LIMIT = 80;

export interface HistoryEntry {
  id: string;
  title: string;
  artist: string;
  cover?: string;
  playedAt: number;
}

export function getListeningHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

export const listeningHistoryPlugin: ZenithPlugin = {
  id: 'listening-history',
  name: 'Listening History',
  category: 'utility',
  description: 'Keeps a rolling log of the last 80 tracks you played (stored locally).',
  defaultEnabled: true,
  onTrackChange(info: NowPlayingInfo | null, prevId) {
    if (!info || info.id === prevId) return;
    try {
      const list: HistoryEntry[] = getListeningHistory().filter((e) => e.id !== info.id);
      list.unshift({
        id: info.id,
        title: info.title,
        artist: info.artist,
        cover: info.coverUrl,
        playedAt: Date.now(),
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, LIMIT)));
    } catch {}
  },
  onDisable() {
    /* keep it */
  },
};

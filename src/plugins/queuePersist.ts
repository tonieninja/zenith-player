import { Track } from '../api/youtube';
import { ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_queue_persist';

export interface PersistedQueue {
  queue: Track[];
  index: number;
  playingFrom: string | null;
  /** plain playlist id behind playingFrom, when it is a playlist */
  playingFromId?: string | null;
  progress: number;
  wasPlaying: boolean;
  savedAt: number;
}

export function loadPersistedQueue(): PersistedQueue | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedQueue;
    if (!Array.isArray(data.queue) || data.queue.length === 0) return null;
    const index = Number.isInteger(data.index) ? data.index : 0;
    return {
      ...data,
      index: Math.max(0, Math.min(index, data.queue.length - 1)),
      progress: Number.isFinite(data.progress) ? Math.max(0, data.progress) : 0,
      wasPlaying: Boolean(data.wasPlaying),
    };
  } catch {
    return null;
  }
}

export function savePersistedQueue(
  queue: Track[],
  index: number,
  playingFrom: string | null,
  progress = 0,
  wasPlaying = false,
  playingFromId: string | null = null
) {
  try {
    // keep at most 200 tracks but always the window around the playing one, otherwise a
    // long playlist restored the wrong track (index pointed past the saved slice)
    const LIMIT = 200;
    const safeIndex = Math.max(0, Math.min(index, queue.length - 1));
    const start =
      queue.length > LIMIT ? Math.max(0, Math.min(safeIndex - 20, queue.length - LIMIT)) : 0;
    const payload: PersistedQueue = {
      queue: queue.slice(start, start + LIMIT),
      index: safeIndex - start,
      playingFrom,
      playingFromId,
      progress: Math.max(0, progress),
      wasPlaying,
      savedAt: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

export const queuePersistPlugin: ZenithPlugin = {
  id: 'queue-persist',
  name: 'Remember Queue',
  category: 'playback',
  description: 'Restores your queue, position and resumes playback when you reopen Zenith.',
  defaultEnabled: true,
};

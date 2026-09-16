import { Track } from '../api/youtube';
import { ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_queue_persist';

export interface PersistedQueue {
  queue: Track[];
  index: number;
  playingFrom: string | null;
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
    return {
      ...data,
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
  wasPlaying = false
) {
  try {
    const payload: PersistedQueue = {
      queue: queue.slice(0, 200),
      index,
      playingFrom,
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
  category: 'utility',
  description: 'Restores your queue, position and resumes playback when you reopen Zenith.',
  defaultEnabled: true,
};

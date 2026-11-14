import { Track } from '../api/youtube';
import { tidyByline } from '../utils/feed';
import { knownDurationSec } from '../utils/formatTime';
import { ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_queue_persist';

export interface PersistedQueue {
  queue: Track[];
  index: number;
  playingFrom: string | null;
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
      queue: data.queue.map((t) => {
        const durationSec = knownDurationSec(t);
        return {
          ...t,
          artist: tidyByline(String(t.artist || '')),
          ...(durationSec > 0 ? { durationSec } : {}),
        };
      }),
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
  } catch (err) {
    console.debug('queuePersist savePersistedQueue', err);
  }
}

export const queuePersistPlugin: ZenithPlugin = {
  id: 'queue-persist',
  name: 'Remember Queue',
  category: 'playback',
  description: 'Restores your queue, position and resumes playback when you reopen Zenith.',
  defaultEnabled: true,
};

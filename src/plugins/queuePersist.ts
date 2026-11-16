import { Track } from '../api/youtube';
import { tidyByline } from '../utils/feed';
import { knownDurationSec } from '../utils/playback';
import { ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_queue_persist';
const POS_KEY = 'zenith_queue_pos';

type PersistedPos = { id: string; progress: number; wasPlaying: boolean; savedAt: number };

function readPos(): PersistedPos | null {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null') as PersistedPos | null;
    return p && typeof p.id === 'string' && Number.isFinite(p.progress) ? p : null;
  } catch {
    return null;
  }
}

// sama pozycja w trakcie grania, żeby co kilka sekund nie przepisywać kolejki z setkami utworów
export function savePersistedProgress(trackId: string, progress: number, wasPlaying: boolean) {
  try {
    const pos: PersistedPos = {
      id: trackId,
      progress: Math.max(0, progress),
      wasPlaying,
      savedAt: Date.now(),
    };
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    // brak miejsca: zostaje pozycja z ostatniego pełnego zapisu
  }
}

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
    const pos = readPos();
    const cur = data.queue[Math.max(0, Math.min(index, data.queue.length - 1))];
    if (pos && cur && pos.id === cur.id && pos.savedAt > (data.savedAt || 0)) {
      data.progress = pos.progress;
      data.wasPlaying = pos.wasPlaying;
      data.savedAt = pos.savedAt;
    }
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
): boolean {
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
    return true;
  } catch {
    return false;
  }
}

export type QueueStart = 'last' | 'play' | 'pause';

const START_KEY = 'zenith_queue_start';

export function getQueueStart(): QueueStart {
  const v = localStorage.getItem(START_KEY);
  return v === 'play' || v === 'pause' ? v : 'last';
}

export function setQueueStart(v: QueueStart) {
  localStorage.setItem(START_KEY, v);
}

export function playOnStart(wasPlaying: boolean): boolean {
  const mode = getQueueStart();
  return mode === 'last' ? wasPlaying : mode === 'play';
}

export const queuePersistPlugin: ZenithPlugin = {
  id: 'queue-persist',
  name: 'Remember queue',
  category: 'playback',
  description: 'Restores your queue, position and resumes playback when you reopen Zenith.',
  defaultEnabled: true,
};

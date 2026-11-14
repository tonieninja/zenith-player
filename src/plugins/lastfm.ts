import { invoke } from '@tauri-apps/api/core';
import type { NowPlayingInfo, ZenithPlugin } from './types';

const QUEUE_KEY = 'zenith.lastfm.queue';
type Pending = { artist: string; track: string; duration?: number; timestamp: number };

export interface LastfmStatus {
  configured: boolean;
  user: string | null;
  pending: boolean;
}

export const lastfmStatus = () => invoke<LastfmStatus>('lastfm_status');
export const lastfmSetKeys = (apiKey: string, secret: string) =>
  invoke<LastfmStatus>('lastfm_set_keys', { apiKey, secret });
export const lastfmBeginAuth = () => invoke<string>('lastfm_begin_auth');
export const lastfmFinishAuth = () => invoke<LastfmStatus>('lastfm_finish_auth');
export const lastfmLogout = () => invoke<LastfmStatus>('lastfm_logout');

let cur: {
  info: NowPlayingInfo;
  start: number;
  listened: number;
  lastPos: number;
  done: boolean;
} | null = null;

function readQueue(): Pending[] {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
function writeQueue(q: Pending[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-50)));
  } catch (err) {
    console.debug('lastfm writeQueue', err);
  }
}

async function send(p: Pending): Promise<boolean> {
  try {
    await invoke('lastfm_scrobble', { t: p });
    return true;
  } catch {
    return false;
  }
}

async function flush() {
  const q = readQueue();
  if (!q.length) return;
  const left: Pending[] = [];
  for (const p of q) if (!(await send(p))) left.push(p);
  writeQueue(left);
}

export function scrobbleThreshold(duration: number): number {
  return Math.min(duration / 2, 240);
}

function maybeScrobble() {
  if (!cur || cur.done) return;
  const d = cur.info.duration;
  if (!(d > 30) || cur.listened < scrobbleThreshold(d)) return;
  cur.done = true;
  const p: Pending = {
    artist: cur.info.artist,
    track: cur.info.title,
    duration: Math.round(d),
    timestamp: Math.floor(cur.start / 1000),
  };
  void send(p).then((ok) => {
    if (ok) void flush();
    else writeQueue([...readQueue(), p]);
  });
}

export const lastfmPlugin: ZenithPlugin = {
  id: 'lastfm-scrobbler',
  name: 'Last.fm Scrobbler',
  category: 'integrations',
  description:
    'Scrobbles what you listen to to your Last.fm profile and shows "now playing" there.',
  defaultEnabled: false,
  onTrackChange(info) {
    cur = info
      ? { info, start: Date.now(), listened: 0, lastPos: info.position, done: false }
      : null;
    if (info?.artist && info.title) {
      void invoke('lastfm_now_playing', {
        t: {
          artist: info.artist,
          track: info.title,
          duration: Math.round(info.duration) || undefined,
        },
      }).catch((err) => console.debug('lastfm onTrackChange', err));
    }
  },
  onNowPlaying(info) {
    if (!cur || !info || info.id !== cur.info.id) return;
    const step = info.position - cur.lastPos;
    if (info.isPlaying && step > 0 && step < 3) cur.listened += step;
    cur.lastPos = info.position;
    if (info.duration) cur.info = { ...cur.info, duration: info.duration };
    maybeScrobble();
  },
  onSeek(position) {
    if (cur) cur.lastPos = position;
  },
  onEnable() {
    void flush();
  },
  onDisable() {
    cur = null;
  },
};

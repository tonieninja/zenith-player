import type { NowPlayingInfo, ZenithPlugin } from './types';

export type Scrobble = {
  artist: string;
  track: string;
  duration?: number;
  timestamp: number;
  video_id?: string;
};

export interface ScrobblerOptions {
  id: string;
  name: string;
  description: string;
  queueKey: string;
  nowPlaying(p: Omit<Scrobble, 'timestamp'>): Promise<unknown>;
  submit(p: Scrobble): Promise<unknown>;
}

export function scrobbleThreshold(duration: number): number {
  return Math.min(duration / 2, 240);
}

export function createScrobbler(o: ScrobblerOptions): ZenithPlugin {
  let cur: {
    info: NowPlayingInfo;
    start: number;
    listened: number;
    lastPos: number;
    done: boolean;
  } | null = null;

  const readQueue = (): Scrobble[] => {
    try {
      const q = JSON.parse(localStorage.getItem(o.queueKey) || '[]');
      return Array.isArray(q) ? q : [];
    } catch {
      return [];
    }
  };
  const writeQueue = (q: Scrobble[]) => {
    try {
      localStorage.setItem(o.queueKey, JSON.stringify(q.slice(-50)));
    } catch {
      /* pełny localStorage: tracimy najstarsze zaległe odsłuchy, nie odtwarzanie */
    }
  };
  const send = (p: Scrobble) =>
    o.submit(p).then(
      () => true,
      () => false
    );
  const flush = async () => {
    const q = readQueue();
    if (!q.length) return;
    const left: Scrobble[] = [];
    for (const p of q) if (!(await send(p))) left.push(p);
    writeQueue(left);
  };
  const maybeScrobble = () => {
    if (!cur || cur.done) return;
    const d = cur.info.duration;
    if (!(d > 30) || cur.listened < scrobbleThreshold(d)) return;
    cur.done = true;
    const p: Scrobble = {
      artist: cur.info.artist,
      track: cur.info.title,
      duration: Math.round(d),
      timestamp: Math.floor(cur.start / 1000),
      video_id: cur.info.id,
    };
    void send(p).then((ok) => {
      if (ok) void flush();
      else writeQueue([...readQueue(), p]);
    });
  };

  return {
    id: o.id,
    name: o.name,
    category: 'integrations',
    description: o.description,
    defaultEnabled: false,
    onTrackChange(info) {
      cur = info
        ? { info, start: Date.now(), listened: 0, lastPos: info.position, done: false }
        : null;
      if (info?.artist && info.title) {
        void o
          .nowPlaying({
            artist: info.artist,
            track: info.title,
            duration: Math.round(info.duration) || undefined,
            video_id: info.id,
          })
          .catch(() => {});
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
}

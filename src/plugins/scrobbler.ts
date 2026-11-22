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
  // czas słuchania liczy zegar, nie pozycja: aplikacja zgłasza pozycję tylko przy zmianach, nie co sekundę
  let cur: {
    info: NowPlayingInfo;
    start: number;
    listened: number;
    since: number | null;
    done: boolean;
  } | null = null;

  const tally = () => {
    if (cur?.since == null) return;
    const now = Date.now();
    cur.listened += (now - cur.since) / 1000;
    cur.since = now;
  };
  const setPlaying = (on: boolean) => {
    if (!cur) return;
    tally();
    cur.since = on ? (cur.since ?? Date.now()) : null;
  };
  const begin = (info: NowPlayingInfo | null) => {
    cur = info
      ? {
          info,
          start: Date.now(),
          listened: 0,
          since: info.isPlaying ? Date.now() : null,
          done: false,
        }
      : null;
  };

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
  let flushing = false;
  const flush = async () => {
    // dwa równoległe opróżnienia wysłałyby zaległości podwójnie
    if (flushing) return;
    const q = readQueue();
    if (!q.length) return;
    flushing = true;
    try {
      const sent = new Set<Scrobble>();
      for (const p of q) if (await send(p)) sent.add(p);
      // odsłuchy dopisane w trakcie wysyłki zostają; po indeksie ginęły, gdy pełna kolejka zrzuciła najstarszy
      const before = new Set(q.map((p) => JSON.stringify(p)));
      const added = readQueue().filter((p) => !before.has(JSON.stringify(p)));
      writeQueue([...q.filter((p) => !sent.has(p)), ...added]);
    } finally {
      flushing = false;
    }
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
      tally();
      maybeScrobble();
      begin(info);
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
      tally();
      const d = info.duration || cur.info.duration;
      // pętla jednego utworu nie zmienia utworu, więc powrót na start po przesłuchaniu to nowe odtworzenie
      if (cur.done && info.position < 3 && (Date.now() - cur.start) / 1000 >= d - 5) begin(info);
      setPlaying(info.isPlaying);
      if (cur && info.duration) cur.info = { ...cur.info, duration: info.duration };
      maybeScrobble();
    },
    onPlayStateChange(playing) {
      setPlaying(playing);
      maybeScrobble();
    },
    onEnable() {
      void flush();
    },
    onDisable() {
      cur = null;
    },
  };
}

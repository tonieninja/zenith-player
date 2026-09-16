import { NowPlayingInfo, ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_listen_stats';
const MAX_TRACK_ENTRIES = 200;

export interface ListenStats {
  totalSeconds: number;
  trackPlays: Record<string, number>;
  sessions: number;
}

export function getListenStats(): ListenStats {
  try {
    return JSON.parse(
      localStorage.getItem(STORAGE_KEY) ||
        JSON.stringify({ totalSeconds: 0, trackPlays: {}, sessions: 0 })
    );
  } catch {
    return { totalSeconds: 0, trackPlays: {}, sessions: 0 };
  }
}

function pruneTrackPlays(trackPlays: Record<string, number>) {
  const entries = Object.entries(trackPlays);
  if (entries.length <= MAX_TRACK_ENTRIES) return trackPlays;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_TRACK_ENTRIES));
}

function saveStats(stats: ListenStats) {
  try {
    stats.trackPlays = pruneTrackPlays(stats.trackPlays);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {}
}

let lastTick = 0;
let activeId: string | null = null;

export const statsTrackerPlugin: ZenithPlugin = {
  id: 'stats-tracker',
  name: 'Listening Stats',
  category: 'utility',
  description: 'Tracks total listening time and per-track play counts in the background.',
  defaultEnabled: true,
  onTrackChange(info: NowPlayingInfo | null) {
    activeId = info?.id ?? null;
    lastTick = Date.now();
  },
  onNowPlaying(info) {
    if (!info?.isPlaying || !activeId) {
      lastTick = Date.now();
      return;
    }
    const now = Date.now();
    const delta = (now - lastTick) / 1000;
    lastTick = now;
    if (delta <= 0 || delta > 30) return;
    const stats = getListenStats();
    stats.totalSeconds += delta;
    stats.trackPlays[activeId] = (stats.trackPlays[activeId] || 0) + delta / 60;
    saveStats(stats);
  },
  onPlayStateChange(isPlaying) {
    lastTick = Date.now();
    if (isPlaying && activeId) {
      const stats = getListenStats();
      stats.sessions += 1;
      saveStats(stats);
    }
    if (!isPlaying) activeId = null;
  },
};

export function formatListenStats(stats: ListenStats): string {
  const hrs = Math.floor(stats.totalSeconds / 3600);
  const mins = Math.floor((stats.totalSeconds % 3600) / 60);
  const top = Object.entries(stats.trackPlays)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topLines = top
    .map(([id, min]) => `  ${id.slice(0, 11)}... ${Math.round(min)} min`)
    .join('\n');
  return `${hrs}h ${mins}m total · ${stats.sessions} track starts\nTop:\n${topLines || '  -'}`;
}

import { NowPlayingInfo, ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_listen_stats';
const MAX_TRACK_ENTRIES = 200;

export interface ListenStats {
  totalSeconds: number;
  trackPlays: Record<string, number>;
  sessions: number;
}

export function getListenStats(): ListenStats {
  const empty = (): ListenStats => ({ totalSeconds: 0, trackPlays: {}, sessions: 0 });
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return empty();
    // older / hand-edited data: keep what is valid instead of crashing the panel
    const trackPlays: Record<string, number> = {};
    if (raw.trackPlays && typeof raw.trackPlays === 'object') {
      for (const [k, v] of Object.entries(raw.trackPlays)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) trackPlays[k] = v;
      }
    }
    return {
      totalSeconds: Number.isFinite(raw.totalSeconds) ? Math.max(0, raw.totalSeconds) : 0,
      trackPlays,
      sessions: Number.isFinite(raw.sessions) ? Math.max(0, Math.floor(raw.sessions)) : 0,
    };
  } catch {
    return empty();
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

let activeId: string | null = null;
let playingSince = 0;
let flushTimer: number | undefined;
let enabled = true;
let countedId: string | null = null;

/** add the time listened since the last flush to the stored totals */
function flush() {
  if (!activeId || !playingSince) return;
  const now = Date.now();
  const delta = (now - playingSince) / 1000;
  playingSince = now;
  // a suspended laptop or a frozen loop should not count as hours of music
  if (delta <= 0 || delta > 120) return;
  const stats = getListenStats();
  stats.totalSeconds += delta;
  stats.trackPlays[activeId] = (stats.trackPlays[activeId] || 0) + delta / 60;
  saveStats(stats);
}

function startClock() {
  if (!enabled || !activeId) return;
  if (!playingSince) playingSince = Date.now();
  if (flushTimer === undefined) flushTimer = window.setInterval(flush, 15000);
}

function stopClock() {
  flush();
  playingSince = 0;
  if (flushTimer !== undefined) {
    window.clearInterval(flushTimer);
    flushTimer = undefined;
  }
}

function markStarted() {
  if (activeId && countedId !== activeId) {
    countedId = activeId;
    const stats = getListenStats();
    stats.sessions += 1;
    saveStats(stats);
  }
  startClock();
}

export function resetListenStats() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export const statsTrackerPlugin: ZenithPlugin = {
  id: 'stats-tracker',
  name: 'Listening Stats',
  category: 'interface',
  description: 'Tracks total listening time and per-track play counts in the background.',
  defaultEnabled: false,
  onEnable() {
    enabled = true;
  },
  onDisable() {
    stopClock();
    enabled = false;
  },
  onTrackChange(info: NowPlayingInfo | null) {
    stopClock();
    activeId = info?.id ?? null;
    if (info?.isPlaying) markStarted();
  },
  onPlayStateChange(isPlaying) {
    if (isPlaying) markStarted();
    else stopClock();
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

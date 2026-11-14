export const PREV_RESTART_SECS = 3;

export type LoopMode = 'off' | 'all' | 'one';

export type PrevDecision = { kind: 'restart' } | { kind: 'goto'; index: number } | { kind: 'noop' };

export function pickPrevPosition(painted: number, played?: number | null): number {
  if (Number.isFinite(painted) && painted >= 0) return painted;
  if (played != null && Number.isFinite(played) && played >= 0) return played;
  return 0;
}

export function decidePrevious(opts: {
  positionSec: number;
  queueIndex: number;
  queueLength: number;
  loopMode: LoopMode;
  historyIds?: string[];
  queueIds?: string[];
  shuffleOn?: boolean;
}): PrevDecision {
  const pos = Number.isFinite(opts.positionSec) ? opts.positionSec : 0;
  if (pos >= PREV_RESTART_SECS) return { kind: 'restart' };

  const len = opts.queueLength;
  if (len <= 0) return { kind: 'noop' };

  if (opts.historyIds?.length && opts.queueIds?.length) {
    for (let h = opts.historyIds.length - 1; h >= 0; h -= 1) {
      const id = opts.historyIds[h];
      const idx = opts.queueIds.indexOf(id);
      if (idx >= 0 && idx !== opts.queueIndex) {
        return { kind: 'goto', index: idx };
      }
    }
  }

  const idx = opts.queueIndex;
  if (idx > 0) return { kind: 'goto', index: idx - 1 };
  if (opts.loopMode === 'all' && len > 0) return { kind: 'goto', index: len - 1 };
  return { kind: 'noop' };
}

export function pushPlayHistory(
  history: string[],
  trackId: string | null | undefined,
  cap = 200
): string[] {
  if (!trackId) return history;
  if (history[history.length - 1] === trackId) return history;
  const next = history.length >= cap ? history.slice(history.length - cap + 1) : history.slice();
  next.push(trackId);
  return next;
}

export function popPlayHistory(
  history: string[],
  currentId: string | null | undefined
): {
  history: string[];
  previousId: string | null;
} {
  const next = history.slice();
  while (next.length && next[next.length - 1] === currentId) next.pop();
  const previousId = next.pop() ?? null;
  return { history: next, previousId };
}

export function formatTime(time: number): string {
  if (isNaN(time) || !isFinite(time) || time < 0) return '0:00';
  const secs = Math.floor(time % 60)
    .toString()
    .padStart(2, '0');
  // strumień na żywo ma nieskończony czas, więc godzina i więcej to zwykłe długie nagranie
  if (time >= 3600) {
    const mins = Math.floor((time % 3600) / 60)
      .toString()
      .padStart(2, '0');
    return `${Math.floor(time / 3600)}:${mins}:${secs}`;
  }
  return `${Math.floor(time / 60)}:${secs}`;
}

export function knownDurationSec(
  track?: { durationSec?: number | null } | null,
  fallback = 0
): number {
  const sec = Number(track?.durationSec);
  if (Number.isFinite(sec) && sec > 0) return sec;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

export function barDurationForTrack(
  trackKnownSec: number,
  audioDuration: number,
  audioBelongsToTrack: boolean
): number {
  if (audioBelongsToTrack && Number.isFinite(audioDuration) && audioDuration > 0) {
    return audioDuration;
  }
  if (Number.isFinite(trackKnownSec) && trackKnownSec > 0) return trackKnownSec;
  return 0;
}

/** Spotify-like previous: restart current track if past this many seconds. */
export const PREV_RESTART_SECS = 3;

export type LoopMode = 'off' | 'all' | 'one';

export type PrevDecision =
  | { kind: 'restart' }
  | { kind: 'goto'; index: number }
  | { kind: 'noop' };

/** Prefer the painted time for this track; the audio element can still report the old deck. */
export function pickPrevPosition(painted: number, played?: number | null): number {
  if (Number.isFinite(painted) && painted >= 0) return painted;
  if (played != null && Number.isFinite(played) && played >= 0) return played;
  return 0;
}

/** Previous: restart after a few seconds, else last history item, else queue-1. */
export function decidePrevious(opts: {
  positionSec: number;
  queueIndex: number;
  queueLength: number;
  loopMode: LoopMode;
  /** track ids played before the current one (most recent last) */
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

/** Push current id onto a capped history stack (skips duplicates of the tail). */
export function pushPlayHistory(history: string[], trackId: string | null | undefined, cap = 200): string[] {
  if (!trackId) return history;
  if (history[history.length - 1] === trackId) return history;
  const next = history.length >= cap ? history.slice(history.length - cap + 1) : history.slice();
  next.push(trackId);
  return next;
}

/** Pop history entries until one differs from currentId (or empty). */
export function popPlayHistory(history: string[], currentId: string | null | undefined): {
  history: string[];
  previousId: string | null;
} {
  const next = history.slice();
  while (next.length && next[next.length - 1] === currentId) next.pop();
  const previousId = next.pop() ?? null;
  return { history: next, previousId };
}

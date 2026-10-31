/**
 * which lyric line is "now"
 * offsetMs > 0 means highlight a bit earlier
 *
 * lrc stamps are usually a hair early vs youtube audio so without a hold
 * the NEXT line lights up while youre still singing the last one
 */
const LATE_BIAS_S = 0.35;
const HOLD_NEXT_S = 0.22;

export function getActiveLyricIndex(
  synced: ReadonlyArray<{ time: number }> | undefined | null,
  progress: number,
  offsetMs = 0
): number {
  if (!synced?.length) return -1;
  const t = progress + offsetMs / 1000 - LATE_BIAS_S;
  if (t < synced[0].time) return -1;

  let idx = 0;
  for (let i = synced.length - 1; i >= 0; i -= 1) {
    if (t >= synced[i].time) {
      idx = i;
      break;
    }
  }

  // sit on this line until we actually entered the next stamp
  if (idx > 0) {
    const gap = Math.max(0, synced[idx].time - synced[idx - 1].time);
    const hold = Math.min(HOLD_NEXT_S, Math.max(0.08, gap * 0.35));
    if (t < synced[idx].time + hold) idx -= 1;
  }

  while (idx > 0 && synced[idx - 1].time === synced[idx].time) idx -= 1;
  return idx;
}

/**
 * lower bound (in media seconds) until getActiveLyricIndex can return something other
 * than `idx`: the next stamp after the current line, before the hold is applied. lets
 * the caller sleep until shortly before a line change instead of polling every frame
 */
export function secondsUntilLyricChange(
  synced: ReadonlyArray<{ time: number }> | undefined | null,
  progress: number,
  idx: number,
  offsetMs = 0
): number {
  if (!synced?.length) return Number.POSITIVE_INFINITY;
  const t = progress + offsetMs / 1000 - LATE_BIAS_S;
  let j = Math.max(0, idx + 1);
  // skip stamps already passed (the hold keeps idx behind them for a moment)
  while (j < synced.length && synced[j].time <= t) j += 1;
  if (j >= synced.length) return Number.POSITIVE_INFINITY;
  return Math.max(0, synced[j].time - t);
}

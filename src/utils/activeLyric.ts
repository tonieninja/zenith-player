import { useSyncExternalStore } from 'react';

// linia wchodzi ~120 ms przed znacznikiem LRC, to pokrywa klatkę renderu i początek przejścia
const LEAD_S = 0.12;

export function getActiveLyricIndex(
  synced: ReadonlyArray<{ time: number }> | undefined | null,
  progress: number,
  offsetMs = 0
): number {
  if (!synced?.length) return -1;
  const t = progress + offsetMs / 1000 + LEAD_S;
  if (t < synced[0].time) return -1;

  let idx = 0;
  for (let i = synced.length - 1; i >= 0; i -= 1) {
    if (t >= synced[i].time) {
      idx = i;
      break;
    }
  }

  while (idx > 0 && synced[idx - 1].time === synced[idx].time) idx -= 1;
  return idx;
}

export function secondsUntilLyricChange(
  synced: ReadonlyArray<{ time: number }> | undefined | null,
  progress: number,
  idx: number,
  offsetMs = 0
): number {
  if (!synced?.length) return Number.POSITIVE_INFINITY;
  const t = progress + offsetMs / 1000 + LEAD_S;
  let j = Math.max(0, idx + 1);
  while (j < synced.length && synced[j].time <= t) j += 1;
  if (j >= synced.length) return Number.POSITIVE_INFINITY;
  return Math.max(0, synced[j].time - t);
}

let current = -1;
const listeners = new Set<() => void>();

export function setActiveLyricLine(idx: number) {
  if (idx === current) return;
  current = idx;
  for (const l of listeners) l();
}

export function getActiveLyricLine() {
  return current;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useActiveLyricLine() {
  return useSyncExternalStore(subscribe, getActiveLyricLine, getActiveLyricLine);
}

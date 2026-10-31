import { useSyncExternalStore } from 'react';

/**
 * the highlighted lyric line lives outside App's state: it changes every few seconds
 * while playing, and as App state every change re-rendered the whole app tree (and
 * left a matching pile of garbage for the GC) just to move one highlight
 */
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

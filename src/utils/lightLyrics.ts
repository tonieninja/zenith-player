import { useSyncExternalStore } from 'react';

/**
 * "Light lyrics": lines still scroll/highlight, but the active line has no karaoke wipe
 * (the wipe is the most expensive paint on machines without GPU compositing).
 * OFF by default; stored in localStorage so the overlay windows follow it too.
 */
export const LIGHT_LYRICS_KEY = 'zenith_light_lyrics';

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(LIGHT_LYRICS_KEY) === '1';
  } catch {
    return false;
  }
}

let current = read();

export function isLightLyrics(): boolean {
  return current;
}

export function setLightLyrics(on: boolean) {
  current = on;
  try {
    localStorage.setItem(LIGHT_LYRICS_KEY, on ? '1' : '0');
  } catch {}
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // other windows (lyrics overlay / second screen) change it through localStorage
  const onStorage = (e: StorageEvent) => {
    if (e.key !== LIGHT_LYRICS_KEY) return;
    current = read();
    cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

export function useLightLyrics(): boolean {
  return useSyncExternalStore(subscribe, isLightLyrics, () => false);
}

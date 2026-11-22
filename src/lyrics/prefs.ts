import { useSyncExternalStore } from 'react';
import type { LyricsProvider } from '../api/youtube';
import { storedFlag } from './flag';

export type LyricsSource = Exclude<LyricsProvider, 'Auto'>;
export type LyricsPrefs = { order: LyricsSource[]; off: LyricsSource[] };

// Musixmatch na szczycie: LRCLib zwykle odpowiada pierwszy, a Auto podmienia go, gdy dojdzie Musixmatch
export const DEFAULT_SOURCE_ORDER: LyricsSource[] = [
  'Musixmatch',
  'LRCLib',
  'LyricsPlus',
  'Boidu',
  'YouTube Music',
  'Unison',
  'Netease',
  'QQ Music',
  'Kugou',
  'LyricsGenius',
  'Lyrics.ovh',
];

const KEY = 'zenith_lyrics_sources';
const listeners = new Set<() => void>();

export function normalizeLyricsPrefs(raw: string | null): LyricsPrefs {
  let data: { order?: unknown; off?: unknown };
  try {
    data = JSON.parse(raw || '{}') ?? {};
  } catch {
    data = {};
  }
  const known = (v: unknown): LyricsSource[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is LyricsSource => DEFAULT_SOURCE_ORDER.includes(x)))]
      : [];
  const order = known(data.order);
  // źródło dodane w nowszej wersji trafia na swoje domyślne miejsce, nie na koniec listy
  DEFAULT_SOURCE_ORDER.forEach((id, i) => {
    if (!order.includes(id)) order.splice(Math.min(i, order.length), 0, id);
  });
  return { order, off: known(data.off) };
}

let current = normalizeLyricsPrefs(localStorage.getItem(KEY));

export const getLyricsPrefs = () => current;

export function setLyricsPrefs(next: LyricsPrefs | null) {
  if (next) localStorage.setItem(KEY, JSON.stringify(next));
  else localStorage.removeItem(KEY);
  current = normalizeLyricsPrefs(next ? JSON.stringify(next) : null);
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = normalizeLyricsPrefs(e.newValue);
    cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

export const useLyricsPrefs = () => useSyncExternalStore(subscribe, getLyricsPrefs, getLyricsPrefs);

export const enabledSources = (p: LyricsPrefs) => p.order.filter((id) => !p.off.includes(id));

export const lyricsPrefsKey = (p: LyricsPrefs) =>
  enabledSources(p)
    .map((id) => DEFAULT_SOURCE_ORDER.indexOf(id).toString(36))
    .join('');

export function moveSource(p: LyricsPrefs, id: LyricsSource, to: number): LyricsPrefs {
  const from = p.order.indexOf(id);
  if (from < 0 || to < 0 || to >= p.order.length) return p;
  const order = [...p.order];
  order.splice(to, 0, ...order.splice(from, 1));
  return { ...p, order };
}

export function toggleSource(p: LyricsPrefs, id: LyricsSource, on: boolean): LyricsPrefs {
  return { ...p, off: on ? p.off.filter((x) => x !== id) : [...new Set([...p.off, id])] };
}

export const lyricsUpgrade = storedFlag('zenith_lyrics_upgrade', () => true);

// klucz pamięci podręcznej: zmiana źródeł albo podmiany musi pobrać tekst od nowa
export const lyricsSourcesKey = () => `${lyricsPrefsKey(current)}:${lyricsUpgrade.get() ? 1 : 0}`;

import { emit } from '@tauri-apps/api/event';
import { ZenithPlugin } from './types';

export const BLOCKED_ARTISTS_KEY = 'zenith_blocked_artists';
// kolejka z samymi zablokowanymi nie może przewijać się bez końca
const MAX_SKIPS = 10;

export function readBlocked(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(BLOCKED_ARTISTS_KEY) || '[]');
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && !!x.trim())
      : [];
  } catch {
    return [];
  }
}

export function saveBlocked(list: string[]) {
  localStorage.setItem(BLOCKED_ARTISTS_KEY, JSON.stringify(list));
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// całe słowa: blokada „Prince” nie łapie „Princess Nokia”, a „Artist • 3M plays” nadal pasuje
export function isBlocked(artist: string, blocked: string[]): boolean {
  const a = ` ${words(artist)} `;
  return blocked.some((b) => {
    const w = words(b);
    return !!w && a.includes(` ${w} `);
  });
}

export function skipCurrent() {
  void emit('zenith-mini-action', 'next').catch(() => undefined);
}

let skips = 0;

export const blockArtistsPlugin: ZenithPlugin = {
  id: 'block-artists',
  name: 'Block artists',
  category: 'playback',
  description: 'Skips tracks by artists you block.',
  defaultEnabled: false,
  onTrackChange(info) {
    if (!info) return;
    if (!isBlocked(info.artist, readBlocked())) {
      skips = 0;
      return;
    }
    skips += 1;
    if (skips <= MAX_SKIPS) skipCurrent();
  },
};

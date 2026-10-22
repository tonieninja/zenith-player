import { ZenithPlugin } from './types';

export const crossfadePlugin: ZenithPlugin = {
  id: 'crossfade',
  name: 'Crossfade',
  category: 'playback',
  description:
    'Equal-power blends between tracks near the end and on manual skips. Albums can play gapless instead.',
  defaultEnabled: false,
};

export const CROSSFADE_SECS_KEY = 'zenith_crossfade_secs';
export const CROSSFADE_DEFAULT_SECS = 6;
export const CROSSFADE_MIN_SECS = 2;
export const CROSSFADE_MAX_SECS = 12;

export function getCrossfadeSeconds(): number {
  try {
    const raw = Number(localStorage.getItem(CROSSFADE_SECS_KEY));
    if (Number.isFinite(raw) && raw >= CROSSFADE_MIN_SECS && raw <= CROSSFADE_MAX_SECS) return raw;
  } catch {}
  return CROSSFADE_DEFAULT_SECS;
}

export function saveCrossfadeSeconds(secs: number) {
  try {
    localStorage.setItem(CROSSFADE_SECS_KEY, String(secs));
  } catch {}
}

export const GAPLESS_ALBUMS_KEY = 'zenith_gapless_albums';
export const GAPLESS_LEAD_SECS = 0.6;
export const GAPLESS_BLEND_SECS = 0.08;
export const GAPLESS_PREROLL_SECS = 12;

export function getGaplessAlbums(): boolean {
  try {
    return localStorage.getItem(GAPLESS_ALBUMS_KEY) !== '0';
  } catch {}
  return true;
}

export function saveGaplessAlbums(on: boolean) {
  try {
    localStorage.setItem(GAPLESS_ALBUMS_KEY, on ? '1' : '0');
  } catch {}
}

export type AutoTransition = { at: number; fade: number } | null;

export function planAutoTransition(opts: {
  crossfadeOn: boolean;
  crossfadeSecs: number;
  album: boolean;
  gapless: boolean;
  remaining: number;
}): AutoTransition {
  const { crossfadeOn, crossfadeSecs, album, gapless, remaining } = opts;
  if (!(remaining > 0)) return null;
  if (album && gapless) {
    if (remaining <= GAPLESS_LEAD_SECS && remaining > 0.03)
      return { at: remaining, fade: GAPLESS_BLEND_SECS };
    return null;
  }
  if (crossfadeOn && remaining <= crossfadeSecs && remaining > 0.35)
    return { at: remaining, fade: Math.max(1, remaining) };
  return null;
}

export function isAlbumCollectionId(id: string | null | undefined): boolean {
  if (!id) return false;
  const plain = id.startsWith('VL') ? id.slice(2) : id;
  return plain.startsWith('MPREb') || plain.startsWith('OLAK5uy');
}

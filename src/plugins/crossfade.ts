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
/** how early (s) the next album track is started so the handoff lands on the boundary */
export const GAPLESS_LEAD_SECS = 0.6;
/** length of the tiny overlap that hides the decoder start */
export const GAPLESS_BLEND_SECS = 0.08;
/** the next album track is buffered (paused) this long before the boundary */
export const GAPLESS_PREROLL_SECS = 12;

/** albums play back to back with no blend and no silence (on by default) */
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

/**
 * decides when to start the next track automatically.
 * album + gapless: start GAPLESS_LEAD_SECS before the end with a tiny blend.
 * otherwise, crossfade on: start crossfadeSecs before the end and blend over the rest.
 */
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

/** album browse ids (MPREb...) and album playlists (OLAK5uy...), so a restored queue keeps gapless */
export function isAlbumCollectionId(id: string | null | undefined): boolean {
  if (!id) return false;
  const plain = id.startsWith('VL') ? id.slice(2) : id;
  return plain.startsWith('MPREb') || plain.startsWith('OLAK5uy');
}

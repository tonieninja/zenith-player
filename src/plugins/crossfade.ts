import { ZenithPlugin } from './types';

export const crossfadePlugin: ZenithPlugin = {
  id: 'crossfade',
  name: 'Crossfade',
  category: 'playback',
  description:
    'Gapless equal-power blends between tracks - auto-fade near the end and on manual skips.',
  defaultEnabled: true,
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

import { ZenithPlugin } from './types';

export const FADE_PAUSE_MS_KEY = 'zenith_fade_pause_ms';

export function getFadePauseMs(): number {
  try {
    const v = Number(localStorage.getItem(FADE_PAUSE_MS_KEY));
    if (Number.isFinite(v) && v >= 0 && v <= 800) return v;
  } catch {}
  return 280;
}

export function setFadePauseMs(ms: number) {
  try {
    localStorage.setItem(FADE_PAUSE_MS_KEY, String(ms));
  } catch {}
}

export const fadeOnPausePlugin: ZenithPlugin = {
  id: 'fade-on-pause',
  name: 'Fade on Pause',
  category: 'playback',
  description: 'Smooth volume fade when pausing and a gentle fade-in when resuming.',
  defaultEnabled: true,
};

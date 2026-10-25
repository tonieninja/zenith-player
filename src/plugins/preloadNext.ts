import { ZenithPlugin } from './types';

export const PRELOAD_DEPTH_KEY = 'zenith_preload_depth';

export function getPreloadDepth(): number {
  const v = Number(localStorage.getItem(PRELOAD_DEPTH_KEY));
  if (Number.isFinite(v) && v >= 1 && v <= 3) return v;
  return 2;
}

export function setPreloadDepth(n: number) {
  localStorage.setItem(PRELOAD_DEPTH_KEY, String(Math.max(1, Math.min(3, n))));
}

export const preloadNextPlugin: ZenithPlugin = {
  id: 'preload-next',
  name: 'Preload next',
  category: 'playback',
  description: 'Prefetches stream URLs for the next 1-3 tracks in the queue.',
  defaultEnabled: true,
};

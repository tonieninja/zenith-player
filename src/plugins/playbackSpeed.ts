import { ZenithPlugin } from './types';

export const PLAYBACK_SPEED_KEY = 'zenith_playback_speed';
export const PLAYBACK_SPEEDS = [0.75, 0.85, 1, 1.15, 1.25, 1.5, 1.75, 2] as const;

export function getPlaybackSpeed(enabled: boolean): number {
  if (!enabled) return 1;
  try {
    const v = Number(localStorage.getItem(PLAYBACK_SPEED_KEY));
    if (PLAYBACK_SPEEDS.includes(v as (typeof PLAYBACK_SPEEDS)[number])) return v;
  } catch (err) {
    console.debug('playbackSpeed getPlaybackSpeed', err);
  }
  return 1;
}

export function setPlaybackSpeed(rate: number) {
  try {
    localStorage.setItem(PLAYBACK_SPEED_KEY, String(rate));
  } catch (err) {
    console.debug('playbackSpeed setPlaybackSpeed', err);
  }
}

export const playbackSpeedPlugin: ZenithPlugin = {
  id: 'playback-speed',
  name: 'Variable Speed',
  category: 'playback',
  description: 'Play tracks faster or slower.',
  defaultEnabled: false,
};

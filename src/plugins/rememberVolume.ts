import { ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_volume';

export function getRememberedVolume(): number | null {
  const v = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(v) && v > 0 && v <= 1) return v;
  return null;
}

export function saveRememberedVolume(v: number) {
  localStorage.setItem(STORAGE_KEY, String(Math.max(0, Math.min(1, v))));
}

const FIXED_ON_KEY = 'zenith_volume_fixed_on';
const FIXED_KEY = 'zenith_volume_fixed';

export const isFixedVolumeOn = () => localStorage.getItem(FIXED_ON_KEY) === '1';

export function setFixedVolumeOn(on: boolean) {
  localStorage.setItem(FIXED_ON_KEY, on ? '1' : '0');
}

export function getFixedVolume(): number {
  const raw = localStorage.getItem(FIXED_KEY);
  const v = Number(raw);
  return raw !== null && Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5;
}

export function setFixedVolume(v: number) {
  localStorage.setItem(FIXED_KEY, String(Math.max(0, Math.min(1, v))));
}

export function startupVolume(): number | null {
  return isFixedVolumeOn() ? getFixedVolume() : getRememberedVolume();
}

export const rememberVolumePlugin: ZenithPlugin = {
  id: 'remember-volume',
  name: 'Remember volume',
  category: 'playback',
  description: 'Restores your last volume level between sessions.',
  defaultEnabled: true,
  core: 'always',
};

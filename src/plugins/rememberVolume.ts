import { ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_volume';

export function getRememberedVolume(): number | null {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    // 0 usually means "never set", silent boot feels more broken than mute
    // cisza na starcie brzmi jak zepsute a nie wyciszone, daj 80% i spoko
    if (Number.isFinite(v) && v > 0 && v <= 1) return v;
  } catch {}
  return null;
}

export function saveRememberedVolume(v: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.max(0, Math.min(1, v))));
  } catch {}
}

export const rememberVolumePlugin: ZenithPlugin = {
  id: 'remember-volume',
  name: 'Remember Volume',
  category: 'utility',
  description: 'Restores your last volume level between sessions.',
  defaultEnabled: true,
};

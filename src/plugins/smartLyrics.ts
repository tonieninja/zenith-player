import { ZenithPlugin } from './types';

export const SMART_LYRICS_KEY = 'zenith_smart_lyrics';

export function isSmartLyricsEnabled(): boolean {
  try {
    return localStorage.getItem(SMART_LYRICS_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setSmartLyricsEnabled(on: boolean) {
  try {
    localStorage.setItem(SMART_LYRICS_KEY, on ? '1' : '0');
  } catch (err) {
    console.debug('smartLyrics setSmartLyricsEnabled', err);
  }
}

export const smartLyricsPlugin: ZenithPlugin = {
  id: 'smart-lyrics',
  name: 'Smart Lyrics Search',
  category: 'lyrics',
  description:
    'Cleans track titles before lyrics lookup (drops Artist - prefix and feat. credits). Turn off if a match is wrong.',
  defaultEnabled: true,
  onEnable() {
    setSmartLyricsEnabled(true);
  },
  onDisable() {
    setSmartLyricsEnabled(false);
  },
};

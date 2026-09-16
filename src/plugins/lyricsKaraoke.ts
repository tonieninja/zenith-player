import { ZenithPlugin } from './types';

export const KARAOKE_KEY = 'zenith_karaoke_mode';
export const HIGH_CONTRAST_KEY = 'zenith_lyrics_high_contrast';

export function isKaraokeMode(): boolean {
  try {
    return localStorage.getItem(KARAOKE_KEY) === '1';
  } catch {}
  return false;
}

export function setKaraokeMode(on: boolean) {
  try {
    localStorage.setItem(KARAOKE_KEY, on ? '1' : '0');
  } catch {}
}

export function isHighContrastLyrics(): boolean {
  try {
    return localStorage.getItem(HIGH_CONTRAST_KEY) !== '0';
  } catch {}
  return true;
}

export function setHighContrastLyrics(on: boolean) {
  try {
    localStorage.setItem(HIGH_CONTRAST_KEY, on ? '1' : '0');
  } catch {}
}

export const lyricsKaraokePlugin: ZenithPlugin = {
  id: 'lyrics-karaoke',
  name: 'Lyrics Karaoke Pro',
  category: 'visual',
  description:
    'Karaoke-style active line glow, next-line preview, beat pulse and high-contrast text for any screen.',
  defaultEnabled: false,
};

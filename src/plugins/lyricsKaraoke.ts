import { ZenithPlugin } from './types';

export const KARAOKE_KEY = 'zenith_karaoke_mode';
export const HIGH_CONTRAST_KEY = 'zenith_lyrics_high_contrast';

export function isKaraokeMode(): boolean {
  try {
    return localStorage.getItem(KARAOKE_KEY) === '1';
  } catch (err) {
    console.debug('lyricsKaraoke isKaraokeMode', err);
  }
  return false;
}

export function setKaraokeMode(on: boolean) {
  try {
    localStorage.setItem(KARAOKE_KEY, on ? '1' : '0');
  } catch (err) {
    console.debug('lyricsKaraoke setKaraokeMode', err);
  }
}

export function isHighContrastLyrics(): boolean {
  try {
    return localStorage.getItem(HIGH_CONTRAST_KEY) !== '0';
  } catch (err) {
    console.debug('lyricsKaraoke isHighContrastLyrics', err);
  }
  return true;
}

export function setHighContrastLyrics(on: boolean) {
  try {
    localStorage.setItem(HIGH_CONTRAST_KEY, on ? '1' : '0');
  } catch (err) {
    console.debug('lyricsKaraoke setHighContrastLyrics', err);
  }
}

export const lyricsKaraokePlugin: ZenithPlugin = {
  id: 'lyrics-karaoke',
  name: 'Lyrics Karaoke',
  category: 'lyrics',
  description:
    'Karaoke-style active line glow, next-line preview, beat pulse and high-contrast text for any screen.',
  defaultEnabled: false,
};

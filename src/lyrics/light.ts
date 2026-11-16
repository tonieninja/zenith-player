import { storedFlag } from './flag';

export const LIGHT_LYRICS_KEY = 'zenith_light_lyrics';

const flag = storedFlag(LIGHT_LYRICS_KEY);

export const isLightLyrics = flag.get;
export const setLightLyrics = flag.set;
export const useLightLyrics = flag.useValue;

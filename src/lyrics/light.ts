import { storedFlag } from './flag';

export const LIGHT_LYRICS_KEY = 'zenith_light_lyrics';

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)');

// przy systemowym „ogranicz ruch” lekki tekst jest domyślnie włączony, dopóki ktoś go nie przełączy
const flag = storedFlag(
  LIGHT_LYRICS_KEY,
  () => reduceMotion()?.matches ?? false,
  (cb) => {
    const mq = reduceMotion();
    mq?.addEventListener('change', cb);
    return () => mq?.removeEventListener('change', cb);
  }
);

export const isLightLyrics = flag.get;
export const setLightLyrics = flag.set;
export const useLightLyrics = flag.useValue;

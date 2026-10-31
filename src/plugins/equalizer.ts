/**
 * Equalizer (15 ISO bands, presets) and Loudness Normalization. The audio work happens in the
 * engine: Web Audio filters for the WebView engine (src/audio/webFx.ts), GStreamer
 * equalizer-nbands / level for the native Linux engine (src-tauri/src/native_audio.rs).
 */
import { ZenithPlugin } from './types';

export const EQ_BANDS_KEY = 'zenith_eq_bands';
export const EQ_PRESET_KEY = 'zenith_eq_preset';
/** ISO 2/3-octave graphic EQ centres (Hz); the native engine has the same list in native_audio.rs */
export const EQ_FREQS = [
  25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000,
] as const;
/** peaking filter Q for 2/3-octave spacing */
export const EQ_Q = 1.4;
export const EQ_LABELS = EQ_FREQS.map((f) =>
  f >= 1000 ? `${(f / 1000).toString().replace(/\.0$/, '')}k` : String(f)
);
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

/**
 * Bass Boost curve, one gain in dB per band in EQ_FREQS order:
 * 25, 40, 63, 100, 160, 250, 400, 630, 1k, 1.6k, 2.5k, 4k, 6.3k, 10k, 16k Hz.
 * Edit the numbers here; the preset list, the UI and both audio engines read this.
 */
export const BASS_BOOST_BANDS: readonly number[] = [
  4, 5.5, 5, 1.8, 0, 0, 0.8, 0.8, 0, 0, 0.5, 0.5, 0.5, 0.3, 0.3,
];

/** the old 10-band layout, only used to carry saved curves over */
const LEGACY_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** resample a curve from LEGACY_FREQS onto EQ_FREQS (linear in log-frequency) */
export function fromLegacyBands(old: number[]): number[] {
  const lf = LEGACY_FREQS.map(Math.log2);
  return EQ_FREQS.map((f) => {
    const x = Math.log2(f);
    if (x <= lf[0]) return old[0];
    if (x >= lf[lf.length - 1]) return old[old.length - 1];
    let i = 0;
    while (lf[i + 1] < x) i += 1;
    const t = (x - lf[i]) / (lf[i + 1] - lf[i]);
    return Math.round((old[i] + (old[i + 1] - old[i]) * t) * 10) / 10;
  });
}

const flat = () => EQ_FREQS.map(() => 0);

export const EQ_PRESETS: Record<string, number[]> = {
  flat: flat(),
  // key stays 'bass' so a preset picked before keeps working
  bass: [...BASS_BOOST_BANDS],
  treble: fromLegacyBands([0, 0, 0, 0, 0, 1, 2, 4, 5, 6]),
  vocal: fromLegacyBands([-2, -2, -1, 1, 3, 4, 3, 1, 0, -1]),
  rock: fromLegacyBands([4, 3, 1, -1, -2, -1, 1, 3, 4, 4]),
  electronic: fromLegacyBands([5, 4, 1, 0, -2, 1, 0, 1, 4, 5]),
  acoustic: fromLegacyBands([3, 2, 1, 1, 2, 2, 3, 3, 2, 1]),
  loudness: fromLegacyBands([5, 3, 0, 0, -1, 0, 0, 1, 3, 4]),
};

const clampDb = (x: number) => Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, x));

export function getEqBands(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(EQ_BANDS_KEY) || 'null');
    if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
      if (v.length === EQ_FREQS.length) return v.map(clampDb);
      if (v.length === LEGACY_FREQS.length) {
        // a named preset gets its new curve, a custom one is resampled
        const preset = getEqPreset();
        if (EQ_PRESETS[preset]) return [...EQ_PRESETS[preset]];
        return fromLegacyBands(v).map(clampDb);
      }
    }
  } catch {}
  return flat();
}

/** headroom in dB applied before output so a boosted curve never clips */
export function eqPreampDb(bands: number[]): number {
  return -Math.min(EQ_MAX_DB, Math.max(0, ...bands));
}

export function getEqPreset(): string {
  try {
    return localStorage.getItem(EQ_PRESET_KEY) || 'flat';
  } catch {}
  return 'flat';
}

type FxTarget = { setFx(bands: number[] | null, norm: boolean): void };
let target: FxTarget | null = null;
let eqOn = false;
let normOn = false;

function push() {
  target?.setFx(eqOn ? getEqBands() : null, normOn);
}

/** App: the player audio + current plugin switches (called when either changes) */
export function bindFx(audio: FxTarget, eq: boolean, norm: boolean) {
  const changed = audio !== target || eq !== eqOn || norm !== normOn;
  target = audio;
  eqOn = eq;
  normOn = norm;
  if (changed) push();
}

export function setEqBands(bands: number[], preset: string) {
  try {
    localStorage.setItem(EQ_BANDS_KEY, JSON.stringify(bands));
    localStorage.setItem(EQ_PRESET_KEY, preset);
  } catch {}
  push();
}

export const equalizerPlugin: ZenithPlugin = {
  id: 'equalizer',
  name: 'Equalizer',
  category: 'sound',
  description:
    '15-band graphic equalizer with presets (Bass Boost, treble, vocal, rock, electronic...).',
  defaultEnabled: false,
};

export const loudnessPlugin: ZenithPlugin = {
  id: 'loudness-normalization',
  name: 'Loudness Normalization',
  category: 'sound',
  description:
    'Evens out volume between tracks: loud masters are turned down to a common level (never boosted, so no clipping).',
  defaultEnabled: false,
};

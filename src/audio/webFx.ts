/**
 * Equalizer + loudness normalization for the WebView <audio> engine (Windows, macOS and the
 * Linux fallback). Built lazily the first time either feature is on, after a user gesture
 * (an AudioContext created without one can start suspended and would silence the routed
 * elements). Graph per deck: element -> norm gain -> 15 peaking filters (shared) -> preamp -> out,
 * plus an analyser tap used for the first ~12 s of each track. Flat EQ + gain 1 is an exact
 * passthrough; a few biquads cost well under 1% of a core.
 */

import { EQ_FREQS, EQ_Q, eqPreampDb } from '../plugins/equalizer';

export { EQ_FREQS };

/** same numbers as the native engine (src-tauri/src/native_audio.rs) */
const NORM_BLOCKS = 30;
const NORM_TARGET_DB = -16;
const NORM_MAX_CUT_DB = -10;

export function normGainDb(sum: number, n: number): number | null {
  if (n < 5) return null;
  const mean = 10 * Math.log10(sum / n);
  return Math.max(NORM_MAX_CUT_DB, Math.min(0, NORM_TARGET_DB - mean));
}

type Deck = {
  el: HTMLAudioElement;
  src: MediaElementAudioSourceNode;
  gain: GainNode;
  an: AnalyserNode;
  sum: number;
  n: number;
  timer: number;
};

export class WebFx {
  private ctx: AudioContext | null = null;
  private decks: Deck[] = [];
  private filters: BiquadFilterNode[] = [];
  private preamp: GainNode | null = null;
  private bands: number[] = EQ_FREQS.map(() => 0);
  private norm = false;
  private buf = new Float32Array(2048);
  private waiting = false;

  constructor(
    private readonly els: HTMLAudioElement[],
    private readonly reloadActive: () => void
  ) {}

  get active() {
    return this.ctx !== null;
  }

  get state(): string {
    return this.ctx ? this.ctx.state : this.waiting ? 'waiting-for-gesture' : 'off';
  }

  configure(bands: number[] | null, norm: boolean) {
    this.bands = bands ? bands.slice(0, EQ_FREQS.length) : EQ_FREQS.map(() => 0);
    this.norm = norm;
    const wanted = Boolean(bands && bands.some((b) => b !== 0)) || norm;
    if (!this.ctx && wanted) this.build();
    this.apply();
  }

  private build() {
    const activated =
      typeof navigator !== 'undefined' &&
      (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
        ?.hasBeenActive;
    // the QA run has no real input; it says so explicitly
    const qa = (window as Window & { __zenithQaNoGesture?: boolean }).__zenithQaNoGesture;
    if (activated === false && !qa) {
      if (this.waiting) return;
      this.waiting = true;
      const go = () => {
        window.removeEventListener('pointerdown', go, true);
        window.removeEventListener('keydown', go, true);
        this.waiting = false;
        this.build();
        this.apply();
      };
      window.addEventListener('pointerdown', go, true);
      window.addEventListener('keydown', go, true);
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: 'playback' });
    } catch {
      return;
    }
    this.ctx = ctx;
    this.filters = EQ_FREQS.map((f) => {
      const b = ctx.createBiquadFilter();
      b.type = 'peaking';
      b.frequency.value = f;
      b.Q.value = EQ_Q;
      b.gain.value = 0;
      return b;
    });
    for (let i = 0; i < this.filters.length - 1; i += 1)
      this.filters[i].connect(this.filters[i + 1]);
    this.preamp = ctx.createGain();
    this.filters[this.filters.length - 1].connect(this.preamp);
    this.preamp.connect(ctx.destination);
    // the stream proxy answers with CORS headers; without crossOrigin a routed element
    // would play silence. the playing deck is reloaded once at the same position
    this.els.forEach((el) => {
      el.crossOrigin = 'anonymous';
      const src = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(gain);
      src.connect(an);
      gain.connect(this.filters[0]);
      this.decks.push({ el, src, gain, an, sum: 0, n: 0, timer: 0 });
    });
    this.reloadActive();
    const resume = () => {
      if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    };
    resume();
    this.els.forEach((el) => el.addEventListener('play', resume));
  }

  private apply() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(this.bands[i] ?? 0, t, 0.05));
    this.preamp?.gain.setTargetAtTime(Math.pow(10, eqPreampDb(this.bands) / 20), t, 0.05);
    for (const d of this.decks) {
      if (!this.norm) {
        this.stopMeasure(d);
        d.gain.gain.setTargetAtTime(1, t, 0.3);
      } else if (!d.timer && d.n < NORM_BLOCKS && !d.el.paused) {
        this.startMeasure(d);
      }
    }
  }

  /** a deck got a new track: forget its level and measure again */
  trackChanged(el: HTMLAudioElement) {
    const d = this.decks.find((x) => x.el === el);
    if (!d || !this.ctx) return;
    this.stopMeasure(d);
    d.sum = 0;
    d.n = 0;
    d.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    d.gain.gain.value = 1;
    if (this.norm) this.startMeasure(d);
  }

  private startMeasure(d: Deck) {
    if (d.timer) return;
    d.timer = window.setInterval(() => this.measure(d), 400);
  }

  private stopMeasure(d: Deck) {
    if (d.timer) clearInterval(d.timer);
    d.timer = 0;
  }

  private measure(d: Deck) {
    if (!this.ctx || !this.norm) return this.stopMeasure(d);
    // fade-ins / very low volume would make the probe noisy: skip those blocks
    if (d.el.paused || d.el.readyState < 3 || d.el.muted || d.el.volume < 0.2) return;
    d.an.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (let i = 0; i < this.buf.length; i += 1) p += this.buf[i] * this.buf[i];
    // the tap sits after the element volume (Chromium applies it to the routed output):
    // divide it back out so the measurement is the track's own level
    p /= this.buf.length * d.el.volume * d.el.volume;
    const db = 10 * Math.log10(p || 1e-12);
    if (db < -50) return;
    d.sum += p;
    d.n += 1;
    const g = normGainDb(d.sum, d.n);
    if (g !== null) {
      d.gain.gain.setTargetAtTime(Math.pow(10, g / 20), this.ctx.currentTime, 0.4);
    }
    if (d.n >= NORM_BLOCKS) this.stopMeasure(d);
  }
}

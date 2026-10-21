import { EQ_FREQS, EQ_Q } from '../plugins/equalizer';

export { EQ_FREQS };

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
  private bass: BiquadFilterNode | null = null;
  private bassDb = 0;
  private bands: number[] = EQ_FREQS.map(() => 0);
  private norm = false;
  private buf = new Float32Array(2048);
  private waiting = false;
  private sleepTimer = 0;

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

  configure(bands: number[] | null, norm: boolean, bass = 0) {
    this.bands = bands ? bands.slice(0, EQ_FREQS.length) : EQ_FREQS.map(() => 0);
    this.norm = norm;
    this.bassDb = bass;
    const wanted = Boolean(bands && bands.some((b) => b !== 0)) || bass > 0 || norm;
    if (!this.ctx && wanted) this.build();
    this.apply();
  }

  private build() {
    const activated =
      typeof navigator !== 'undefined' &&
      (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
        ?.hasBeenActive;
    if (activated === false) {
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
    // ten sam łańcuch co w Ruście: półka basowa, odcięcie poniżej 22 Hz i limiter zamiast przyciszania
    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = 90;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 22;
    hp.Q.value = Math.SQRT1_2;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -1.5;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.003;
    lim.release.value = 0.15;
    this.filters[this.filters.length - 1].connect(this.bass);
    this.bass.connect(hp);
    hp.connect(lim);
    lim.connect(ctx.destination);
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
      if (ctx.state !== 'running')
        void ctx.resume().catch((err) => console.debug('webFx resume', err));
    };
    resume();
    const nap = () => {
      window.clearTimeout(this.sleepTimer);
      this.sleepTimer = window.setTimeout(() => {
        if (ctx.state === 'running' && this.els.every((el) => el.paused))
          void ctx.suspend().catch((err) => console.debug('webFx suspend', err));
      }, 4000);
    };
    this.els.forEach((el) => {
      el.addEventListener('play', resume);
      el.addEventListener('pause', nap);
      el.addEventListener('ended', nap);
      el.addEventListener('emptied', nap);
    });
  }

  private apply() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(this.bands[i] ?? 0, t, 0.05));
    this.bass?.gain.setTargetAtTime(this.bassDb, t, 0.05);
    for (const d of this.decks) {
      if (!this.norm) {
        this.stopMeasure(d);
        d.gain.gain.setTargetAtTime(1, t, 0.3);
      } else if (!d.timer && d.n < NORM_BLOCKS && !d.el.paused) {
        this.startMeasure(d);
      }
    }
  }

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
    if (d.el.paused || d.el.readyState < 3 || d.el.muted || d.el.volume < 0.2) return;
    d.an.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (let i = 0; i < this.buf.length; i += 1) p += this.buf[i] * this.buf[i];
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

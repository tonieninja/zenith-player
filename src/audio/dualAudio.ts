import { WebFx } from './webFx';
import { AB_LOOP_EARLY_S, abLoopSeekTarget } from '../plugins/abLoop';

const FORWARDED_EVENTS = [
  'timeupdate',
  'ended',
  'play',
  'playing',
  'pause',
  'loadedmetadata',
  'durationchange',
  'waiting',
  'canplay',
  'error',
] as const;

function clampVol(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function safeLoad(el: HTMLAudioElement) {
  try {
    el.load();
  } catch {}
}

function waitUntilCanPlay(
  el: HTMLAudioElement,
  token: number,
  getToken: () => number,
  timeoutMs = 14000
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (getToken() !== token) {
      reject(new Error('superseded'));
      return;
    }
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      resolve();
      return;
    }
    let done = false;
    const finish = (ok: boolean, err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener('canplay', onReady);
      el.removeEventListener('loadeddata', onReady);
      el.removeEventListener('error', onErr);
      if (ok) resolve();
      else reject(err || new Error('decode error'));
    };
    const onReady = () => {
      if (getToken() !== token) finish(false, new Error('superseded'));
      else finish(true);
    };
    const onErr = () => finish(false, new Error('decode error'));
    const timer = window.setTimeout(() => {
      if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && getToken() === token) {
        finish(true);
      } else {
        finish(false, new Error(getToken() !== token ? 'superseded' : 'timeout'));
      }
    }, timeoutMs);
    el.addEventListener('canplay', onReady);
    el.addEventListener('loadeddata', onReady);
    el.addEventListener('error', onErr);
  });
}

export class DualAudio {
  private els: [HTMLAudioElement, HTMLAudioElement];
  private active = 0;
  private master = 0.8;
  private mutedFlag = false;
  private target = new EventTarget();
  private fadeRaf = 0;
  private fadeTimer = false;

  private scheduleFade(step: () => void): number {
    if (typeof document !== 'undefined' && document.hidden) {
      this.fadeTimer = true;
      return window.setTimeout(step, 50) || 1;
    }
    this.fadeTimer = false;
    return requestAnimationFrame(() => step()) || 1;
  }

  private cancelFadeFrame() {
    if (!this.fadeRaf) return;
    if (this.fadeTimer) clearTimeout(this.fadeRaf);
    else cancelAnimationFrame(this.fadeRaf);
    this.fadeRaf = 0;
  }
  private fadeToken = 0;
  private fadeGuard = 0;
  private fx: WebFx | null = null;

  get fxState(): string {
    return this.fx?.state ?? 'off';
  }

  setFx(bands: number[] | null, norm: boolean, bass = 0) {
    if (!this.fx) {
      if (!bands && !norm) return;
      this.fx = new WebFx(this.els, () => this.reloadForCors());
    }
    this.fx.configure(bands, norm, bass);
  }

  private reloadForCors() {
    this.silenceOther();
    const el = this.el;
    const src = el.getAttribute('src');
    if (!src) return;
    const t = el.currentTime;
    const playing = !el.paused;
    const once = () => {
      el.removeEventListener('loadedmetadata', once);
      try {
        el.currentTime = t;
      } catch {}
      if (playing) void el.play().catch(() => {});
    };
    el.addEventListener('loadedmetadata', once);
    el.src = src;
    el.load();
  }

  constructor() {
    this.els = [new Audio(), new Audio()];
    this.els.forEach((el, i) => {
      el.preload = 'metadata';
      el.setAttribute('playsinline', 'true');
      for (const type of FORWARDED_EVENTS) {
        el.addEventListener(type, () => {
          if (i === this.active) this.target.dispatchEvent(new Event(type));
        });
      }
      for (const type of ['timeupdate', 'playing', 'seeked', 'ratechange', 'pause']) {
        el.addEventListener(type, () => {
          if (i === this.active) this.armLoop();
        });
      }
    });
    this.applyMasterVolume();
  }

  private loop: { a: number; b: number } | null = null;
  private loopTimer = 0;

  setLoop(a: number | null, b: number | null) {
    this.loop = a != null && b != null && b > a + 0.2 ? { a, b } : null;
    this.armLoop();
  }

  private armLoop() {
    window.clearTimeout(this.loopTimer);
    this.loopTimer = 0;
    const loop = this.loop;
    const el = this.el;
    if (!loop || this.fadeRaf || el.paused) return;
    const jump = abLoopSeekTarget(el.currentTime, loop.a, loop.b);
    if (jump != null) {
      el.currentTime = jump;
      return;
    }
    const wait = ((loop.b - AB_LOOP_EARLY_S - el.currentTime) / (el.playbackRate || 1)) * 1000;
    this.loopTimer = window.setTimeout(() => this.armLoop(), Math.max(10, wait));
  }

  private get el(): HTMLAudioElement {
    return this.els[this.active];
  }

  private get other(): HTMLAudioElement {
    return this.els[1 - this.active];
  }

  get currentTime() {
    return this.el.currentTime;
  }
  set currentTime(v: number) {
    this.el.currentTime = v;
  }

  get duration() {
    return this.el.duration;
  }

  get paused() {
    return this.el.paused;
  }

  get src() {
    return this.el.src;
  }
  set src(v: string) {
    this.loop = null;
    this.cancelFade();
    this.silenceOther();
    this.el.preload = v ? 'auto' : 'metadata';
    if (v) {
      this.el.src = v;
      this.fx?.trackChanged(this.el);
    } else {
      this.el.removeAttribute('src');
    }
    this.applyMasterVolume();
  }

  get volume() {
    return this.master;
  }
  set volume(v: number) {
    this.master = Math.max(0, Math.min(1, v));
    if (!this.fadeRaf) this.applyMasterVolume();
  }

  get muted() {
    return this.mutedFlag;
  }
  set muted(v: boolean) {
    this.mutedFlag = v;
    this.els.forEach((el) => {
      el.muted = v;
    });
  }

  get playbackRate() {
    return this.el.playbackRate;
  }
  set playbackRate(v: number) {
    const rate = Math.max(0.25, Math.min(4, v));
    this.els.forEach((el) => {
      el.playbackRate = rate;
    });
  }

  get isCrossfading() {
    return this.fadeRaf !== 0;
  }

  get hasSource() {
    return Boolean(this.el.src) || Boolean(this.other.src) || this.isCrossfading;
  }

  get readyState() {
    return this.el.readyState;
  }

  get isReady() {
    return this.el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  waitReady(timeoutMs = 12000): Promise<boolean> {
    const el = this.el;
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.removeEventListener('canplay', onReady);
        el.removeEventListener('loadeddata', onReady);
        el.removeEventListener('loadedmetadata', onReady);
        el.removeEventListener('error', onErr);
        resolve(ok);
      };
      const onReady = () => finish(true);
      const onErr = () => finish(false);
      const timer = window.setTimeout(
        () => finish(el.readyState >= HTMLMediaElement.HAVE_METADATA),
        timeoutMs
      );
      el.addEventListener('canplay', onReady);
      el.addEventListener('loadeddata', onReady);
      el.addEventListener('loadedmetadata', onReady);
      el.addEventListener('error', onErr);
    });
  }

  play() {
    this.applyMasterVolume();
    return this.el.play();
  }

  pause() {
    this.cancelFade();
    this.silenceOther();
    this.applyMasterVolume();
    this.el.pause();
  }

  releaseInactive() {
    if (this.fadeRaf) return;
    this.silenceOther();
  }

  load() {
    this.el.load();
  }

  addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
    this.target.addEventListener(type, fn);
  }

  removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
    this.target.removeEventListener(type, fn);
  }

  abortAll() {
    this.loop = null;
    this.cancelFade();
    this.prerolledUrl = '';
    this.els.forEach((el) => {
      el.pause();
      el.removeAttribute('src');
      try {
        el.load();
      } catch {}
    });
    this.applyMasterVolume();
  }

  async crossfadeTo(url: string, seconds: number): Promise<void> {
    this.loop = null;
    const token = ++this.fadeToken;
    if (this.fadeRaf) {
      this.cancelFadeFrame();
    }

    const from = this.el;
    const to = this.other;
    const prerolled = this.prerolledUrl === url && to.getAttribute('src') === url && !to.error;
    this.prerolledUrl = '';
    if (!prerolled) {
      this.silenceOther();
    }
    const fromWasAudible = !from.paused && Boolean(from.src);

    if (!prerolled) {
      to.preload = 'auto';
      to.pause();
      to.currentTime = 0;
      to.src = url;
      this.fx?.trackChanged(to);
    }
    to.volume = 0;
    to.muted = this.mutedFlag;
    to.playbackRate = from.playbackRate || 1;
    if (!prerolled) to.load();

    try {
      await waitUntilCanPlay(to, token, () => this.fadeToken);
    } catch (err) {
      if (token === this.fadeToken) {
        to.pause();
        to.removeAttribute('src');
      }
      throw err instanceof Error ? err : new Error('superseded');
    }
    if (token !== this.fadeToken) {
      to.pause();
      to.removeAttribute('src');
      return;
    }

    try {
      await to.play();
    } catch (err) {
      if (token === this.fadeToken) {
        to.pause();
        to.removeAttribute('src');
      }
      throw err;
    }
    if (token !== this.fadeToken) {
      to.pause();
      to.removeAttribute('src');
      return;
    }

    this.active = 1 - this.active;
    this.target.dispatchEvent(new Event('playing'));
    if (Number.isFinite(to.duration) && to.duration > 0) {
      this.target.dispatchEvent(new Event('loadedmetadata'));
      this.target.dispatchEvent(new Event('durationchange'));
    }

    const started = performance.now();
    const durMs = Math.max(180, seconds * 1000);
    const finish = () => {
      window.clearTimeout(this.fadeGuard);
      this.fadeGuard = 0;
      this.cancelFadeFrame();
      from.pause();
      from.volume = 0;
      from.removeAttribute('src');
      from.preload = 'metadata';
      safeLoad(from);
      to.volume = clampVol(this.master);
      this.armLoop();
    };
    const step = () => {
      this.fadeRaf = 0;
      if (token !== this.fadeToken) {
        from.pause();
        from.volume = 0;
        return;
      }
      // rAF potrafi podać czas sprzed startu, a ujemna głośność kończyła się ciszą
      const t = Math.max(0, Math.min(1, (performance.now() - started) / durMs));
      to.volume = clampVol(this.master * Math.sin((t * Math.PI) / 2));
      if (fromWasAudible) from.volume = clampVol(this.master * Math.cos((t * Math.PI) / 2));
      if (t < 1) this.fadeRaf = this.scheduleFade(step);
      else finish();
    };
    window.clearTimeout(this.fadeGuard);
    this.fadeGuard = window.setTimeout(() => {
      if (token === this.fadeToken && this.fadeRaf) finish();
    }, durMs + 400);
    this.fadeRaf = this.scheduleFade(step);
  }

  ensureOutput(shouldPlay: boolean): boolean {
    if (this.fadeRaf) return false;
    let fixed = false;
    const o = this.other;
    if (!o.paused) {
      o.pause();
      o.volume = 0;
      fixed = true;
    }
    if (Math.abs(this.el.volume - this.master) > 0.001) {
      this.applyMasterVolume();
      fixed = true;
    }
    if (shouldPlay && this.el.paused && this.el.getAttribute('src') && !this.el.ended) {
      void this.el.play().catch(() => {});
      fixed = true;
    }
    return fixed;
  }

  private applyMasterVolume() {
    this.el.volume = clampVol(this.master);
  }

  private cancelFade() {
    this.fadeToken += 1;
    window.clearTimeout(this.fadeGuard);
    this.fadeGuard = 0;
    if (this.fadeRaf) {
      this.cancelFadeFrame();
    }
    this.applyMasterVolume();
  }

  private prerolledUrl = '';

  preroll(url: string): void {
    if (!url || this.fadeRaf) return;
    const o = this.other;
    if (this.prerolledUrl === url && o.getAttribute('src') === url) return;
    o.pause();
    o.volume = 0;
    o.preload = 'auto';
    o.src = url;
    this.fx?.trackChanged(o);
    o.load();
    this.prerolledUrl = url;
  }

  private silenceOther() {
    this.prerolledUrl = '';
    const o = this.other;
    o.pause();
    o.volume = 0;
    o.preload = 'metadata';
    o.removeAttribute('src');
    try {
      o.load();
    } catch {}
  }
}

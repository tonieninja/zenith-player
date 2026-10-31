import { WebFx } from './webFx';

/**
 * two <audio> tags pretending to be one, so we can fade between tracks
 * dwa playery to nie bug, to crossfade, zaufaj
 */

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
    // HAVE_CURRENT_DATA is enough: play() buffers the rest. a prerolled deck that already fired
    // canplay/loadeddata while paused can sit at 2 forever, and waiting for an event that never
    // comes again froze a skip near the end of a track for the whole timeout
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

  /** rAF stops entirely in a minimized/hidden window, so a fade started there never
   * finished (the next track stayed silent): fall back to a timer while hidden */
  private scheduleFade(step: (now: number) => void): number {
    if (typeof document !== 'undefined' && document.hidden) {
      this.fadeTimer = true;
      return window.setTimeout(() => step(performance.now()), 50) || 1;
    }
    this.fadeTimer = false;
    return requestAnimationFrame(step);
  }

  private cancelFadeFrame() {
    if (!this.fadeRaf) return;
    if (this.fadeTimer) clearTimeout(this.fadeRaf);
    else cancelAnimationFrame(this.fadeRaf);
    this.fadeRaf = 0;
  }
  private fadeToken = 0;
  private fx: WebFx | null = null;

  /** equalizer (dB per band, null = off) + loudness normalization, see webFx.ts */
  /** 'off' | the AudioContext state, for the QA checks */
  get fxState(): string {
    return this.fx?.state ?? 'off';
  }

  setFx(bands: number[] | null, norm: boolean) {
    if (!this.fx) {
      if (!bands && !norm) return;
      this.fx = new WebFx(this.els, () => this.reloadForCors());
    }
    this.fx.configure(bands, norm);
  }

  /** the playing deck was loaded without CORS: load it again at the same spot */
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
        // only the active deck talks to the ui. during a crossfade that is the incoming
        // track, so elapsed/duration already belong to the title that is on screen
        el.addEventListener(type, () => {
          if (i === this.active) this.target.dispatchEvent(new Event(type));
        });
      }
    });
    this.applyMasterVolume();
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
    // even mid-fade, master volume has to follow so the fade lands on the new level
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

  /** wait until this deck can actually play, timeout is whatever */
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

  /** dump the idle deck's decoded junk when we arent fading */
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

  /**
   * kill both decks right now, a newer load replaced this one
   */
  abortAll() {
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

  /**
   * fade into url over seconds
   * spam it all you want, latest call wins and we mute any leftover deck
   */
  async crossfadeTo(url: string, seconds: number): Promise<void> {
    const token = ++this.fadeToken;
    if (this.fadeRaf) {
      this.cancelFadeFrame();
    }

    const from = this.el;
    const to = this.other;
    // gapless: preroll() may already have this url buffered in the idle deck
    const prerolled = this.prerolledUrl === url && to.getAttribute('src') === url && !to.error;
    this.prerolledUrl = '';
    if (!prerolled) {
      // cancelled mid-fade the idle deck is often still making noise, shut it up
      // jak przerwiesz fade to drugi deck jeszcze gra, wycisz i spadaj
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
    // the incoming deck started playing before it became the active one, so its own
    // 'playing' was not forwarded: tell the ui now
    this.target.dispatchEvent(new Event('playing'));

    const started = performance.now();
    const durMs = Math.max(180, seconds * 1000);
    const step = (now: number) => {
      if (token !== this.fadeToken) {
        from.pause();
        from.volume = 0;
        return;
      }
      const t = Math.min(1, (now - started) / durMs);
      const fadeIn = Math.sin((t * Math.PI) / 2);
      const fadeOut = Math.cos((t * Math.PI) / 2);
      to.volume = Math.min(1, this.master * fadeIn);
      if (fromWasAudible) {
        from.volume = Math.min(1, this.master * fadeOut);
      }
      if (t < 1) {
        this.fadeRaf = this.scheduleFade(step);
      } else {
        this.fadeRaf = 0;
        from.pause();
        from.volume = 0;
        from.removeAttribute('src');
        from.preload = 'metadata';
        try {
          from.load();
        } catch {}
        to.volume = this.master;
      }
    };
    this.fadeRaf = this.scheduleFade(step);
  }

  /**
   * safety net after a track switch: no fade running means exactly one deck may make sound,
   * at the master volume. returns true when something had to be repaired
   */
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
    this.el.volume = this.master;
  }

  private cancelFade() {
    this.fadeToken += 1;
    if (this.fadeRaf) {
      this.cancelFadeFrame();
    }
    this.applyMasterVolume();
  }

  private prerolledUrl = '';

  /** buffer url in the idle deck (paused, silent) so the next crossfadeTo(url) is instant */
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

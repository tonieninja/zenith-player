import { EQ_FREQS } from '../plugins/equalizer';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface EngineSnapshot {
  t: number;
  d: number | null;
  paused: boolean;
  ready: number;
  src: string;
  hasSource: boolean;
  crossfading: boolean;
  ended: boolean;
}

type Cmd =
  | { op: 'setSrc'; url: string }
  | { op: 'clearSrc' }
  | { op: 'pause' }
  | { op: 'seek'; t: number }
  | { op: 'volume'; v: number }
  | { op: 'muted'; m: boolean }
  | { op: 'rate'; r: number }
  | { op: 'abortAll' }
  | { op: 'releaseInactive' }
  | { op: 'load' }
  | { op: 'eq'; bands: number[]; bass: number }
  | { op: 'norm'; on: boolean }
  | { op: 'loop'; a: number | null; b: number | null };

function domError(name: string, message: string) {
  try {
    return new DOMException(message, name);
  } catch {
    const e = new Error(message);
    e.name = name;
    return e;
  }
}

export class NativeAudio {
  private s: EngineSnapshot = {
    t: 0,
    d: null,
    paused: true,
    ready: 0,
    src: '',
    hasSource: false,
    crossfading: false,
    ended: false,
  };
  private at = performance.now();
  private master = 0.8;
  private mutedFlag = false;
  private rate = 1;
  private target = new EventTarget();
  private seq = 0;
  private volQueued = false;

  static async available(): Promise<boolean> {
    try {
      return await invoke<boolean>('zaudio_available');
    } catch {
      return false;
    }
  }

  constructor(initial?: EngineSnapshot | null) {
    if (initial) this.take(initial);
    void listen<{ type: string; snap: EngineSnapshot }>('zaudio', (e) => {
      this.take(e.payload.snap);
      this.target.dispatchEvent(new Event(e.payload.type));
    });
  }

  private take(s: EngineSnapshot) {
    this.s = s;
    this.at = performance.now();
  }

  private send(cmd: Cmd) {
    const seq = ++this.seq;
    invoke<EngineSnapshot>('zaudio_cmd', { cmd })
      .then((s) => {
        if (seq === this.seq) this.take(s);
      })
      .catch(() => {});
  }

  get currentTime() {
    const s = this.s;
    if (s.paused || s.ready < 4) return s.t;
    const t = s.t + ((performance.now() - this.at) / 1000) * this.rate;
    return s.d != null ? Math.min(t, s.d) : t;
  }
  set currentTime(v: number) {
    const t = Math.max(0, Number(v) || 0);
    this.s = { ...this.s, t, ended: false };
    this.at = performance.now();
    this.send({ op: 'seek', t });
  }

  get duration() {
    return this.s.d ?? NaN;
  }

  get paused() {
    return this.s.paused;
  }

  get src() {
    return this.s.src;
  }
  set src(v: string) {
    this.s = { ...this.s, src: v || '', t: 0, d: null, ready: 0, paused: true, ended: false };
    this.at = performance.now();
    this.send(v ? { op: 'setSrc', url: v } : { op: 'clearSrc' });
  }

  setLoop(a: number | null, b: number | null) {
    this.send({ op: 'loop', a, b });
  }

  setFx(bands: number[] | null, norm: boolean, bass = 0) {
    this.send({ op: 'eq', bands: bands ?? new Array(EQ_FREQS.length).fill(0), bass });
    this.send({ op: 'norm', on: norm });
  }

  get volume() {
    return this.master;
  }
  set volume(v: number) {
    this.master = Math.max(0, Math.min(1, v));
    if (!this.volQueued) {
      this.volQueued = true;
      queueMicrotask(() => {
        this.volQueued = false;
        void invoke('zaudio_cmd', { cmd: { op: 'volume', v: this.master } }).catch(() => {});
      });
    }
  }

  get muted() {
    return this.mutedFlag;
  }
  set muted(v: boolean) {
    this.mutedFlag = v;
    this.send({ op: 'muted', m: v });
  }

  get playbackRate() {
    return this.rate;
  }
  set playbackRate(v: number) {
    this.s = { ...this.s, t: this.currentTime };
    this.at = performance.now();
    this.rate = Math.max(0.25, Math.min(4, v));
    this.send({ op: 'rate', r: this.rate });
  }

  get isCrossfading() {
    return this.s.crossfading;
  }

  get hasSource() {
    return this.s.hasSource || Boolean(this.s.src);
  }

  get readyState() {
    return this.s.ready;
  }

  get isReady() {
    return this.s.ready >= 3;
  }

  waitReady(timeoutMs = 12000): Promise<boolean> {
    if (this.s.ready >= 1) return Promise.resolve(true);
    return invoke<boolean>('zaudio_wait_ready', { timeoutMs }).catch(() => false);
  }

  async play(): Promise<void> {
    ++this.seq;
    this.s = { ...this.s, paused: false, ended: false };
    this.at = performance.now();
    try {
      const s = await invoke<EngineSnapshot>('zaudio_play');
      this.take(s);
    } catch (err) {
      const msg = String(err);
      throw domError(msg.startsWith('AbortError') ? 'AbortError' : 'NotAllowedError', msg);
    }
  }

  pause() {
    this.s = { ...this.s, t: this.currentTime, paused: true };
    this.at = performance.now();
    this.send({ op: 'pause' });
  }

  ensureOutput(_shouldPlay: boolean): boolean {
    return false;
  }

  releaseInactive() {
    if (this.s.crossfading) return;
    this.send({ op: 'releaseInactive' });
  }

  load() {
    this.send({ op: 'load' });
  }

  addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
    this.target.addEventListener(type, fn);
  }

  removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
    this.target.removeEventListener(type, fn);
  }

  abortAll() {
    this.s = { ...this.s, src: '', t: 0, d: null, ready: 0, paused: true, hasSource: false };
    this.at = performance.now();
    this.send({ op: 'abortAll' });
  }

  preroll(url: string): void {
    if (url) void invoke<boolean>('zaudio_preroll', { url }).catch(() => false);
  }

  async crossfadeTo(url: string, seconds: number): Promise<void> {
    ++this.seq;
    const s = await invoke<EngineSnapshot>('zaudio_crossfade', { url, seconds }).catch((err) => {
      throw new Error(String(err));
    });
    this.take(s);
  }
}

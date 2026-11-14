import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeAudio extends EventTarget {
  static all: FakeAudio[] = [];
  static settleAt = 4;
  paused = true;
  volume = 1;
  muted = false;
  playbackRate = 1;
  currentTime = 0;
  duration = 200;
  readyState = 0;
  preload = 'metadata';
  error: null = null;
  ended = false;
  private attrs: Record<string, string> = {};
  constructor() {
    super();
    FakeAudio.all.push(this);
  }
  get src() {
    return this.attrs.src ?? '';
  }
  set src(v: string) {
    this.attrs.src = v;
    this.readyState = 0;
    setTimeout(() => {
      if (this.attrs.src !== v) return;
      this.readyState = FakeAudio.settleAt;
      this.dispatchEvent(new Event('loadedmetadata'));
      this.dispatchEvent(new Event('loadeddata'));
      if (FakeAudio.settleAt >= 3) this.dispatchEvent(new Event('canplay'));
    }, 30);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
    if (k === 'src') this.readyState = 0;
  }
  load() {}
  play() {
    if (!this.attrs.src) return Promise.reject(new Error('no src'));
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

let DualAudio: typeof import('../audio/dualAudio').DualAudio;

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  FakeAudio.all = [];
  FakeAudio.settleAt = 4;
  vi.stubGlobal('Audio', FakeAudio);
  ({ DualAudio } = await import('../audio/dualAudio'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const playing = () => FakeAudio.all.filter((a) => !a.paused && a.getAttribute('src'));

async function settle(ms: number) {
  for (let t = 0; t < ms; t += 20) await vi.advanceTimersByTimeAsync(20);
}

async function startOn(a: InstanceType<typeof DualAudio>, url: string) {
  a.src = url;
  await settle(100);
  await a.play();
}

describe('skipping near the end of a track', () => {
  for (const left of [15, 5, 1, 0.3]) {
    it(`skip with ${left}s left onto the prerolled next track starts it right away`, async () => {
      const a = new DualAudio();
      a.volume = 0.05;
      await startOn(a, 'u1');
      FakeAudio.settleAt = 2;
      a.preroll('u2');
      await settle(200);
      const p = a.crossfadeTo('u2', 0.35);
      await settle(700);
      await p;
      await settle(500);
      expect(playing().map((x) => x.src)).toEqual(['u2']);
      expect(a.src).toBe('u2');
      expect(a.ensureOutput(true)).toBe(false);
      expect(FakeAudio.all.find((x) => x.src === 'u2')!.volume).toBeCloseTo(0.05);
    });
  }

  it('skip during a running crossfade ends with one deck at full volume', async () => {
    const a = new DualAudio();
    a.volume = 0.05;
    await startOn(a, 'u1');
    const p1 = a.crossfadeTo('u2', 6).catch((err) => console.debug('dualAudioSkip', err));
    await settle(1200);
    const p2 = a.crossfadeTo('u3', 0.35);
    await settle(1500);
    await Promise.allSettled([p1, p2]);
    expect(playing().map((x) => x.src)).toEqual(['u3']);
    expect(FakeAudio.all.find((x) => x.src === 'u3')!.volume).toBeCloseTo(0.05);
  });

  it('rapid double skip lands on the last track only', async () => {
    const a = new DualAudio();
    a.volume = 0.05;
    await startOn(a, 'u1');
    a.preroll('u2');
    const p1 = a.crossfadeTo('u2', 0.35).catch((err) => console.debug('dualAudioSkip', err));
    const p2 = a.crossfadeTo('u3', 0.35);
    await settle(1500);
    await Promise.allSettled([p1, p2]);
    expect(playing().map((x) => x.src)).toEqual(['u3']);
  });

  it('hard switch (no fade) while a preroll is loaded plays the new track', async () => {
    const a = new DualAudio();
    a.volume = 0.05;
    await startOn(a, 'u1');
    a.preroll('u2');
    await settle(100);
    a.abortAll();
    await startOn(a, 'u3');
    await settle(200);
    expect(playing().map((x) => x.src)).toEqual(['u3']);
    expect(FakeAudio.all.find((x) => x.src === 'u3')!.volume).toBeCloseTo(0.05);
  });

  it('ensureOutput restarts a deck that should be playing and fixes a stuck volume', async () => {
    const a = new DualAudio();
    a.volume = 0.05;
    await startOn(a, 'u1');
    const el = FakeAudio.all.find((x) => x.src === 'u1')!;
    el.pause();
    el.volume = 0;
    expect(a.ensureOutput(true)).toBe(true);
    expect(el.paused).toBe(false);
    expect(el.volume).toBeCloseTo(0.05);
  });
});

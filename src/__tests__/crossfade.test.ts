import { afterEach, describe, expect, it, vi } from 'vitest';
import { DualAudio } from '../audio/dualAudio';

type Deck = HTMLAudioElement & { _paused: boolean };

function rig(d: DualAudio) {
  const els = (d as unknown as { els: Deck[] }).els;
  for (const el of els) {
    el._paused = true;
    Object.defineProperty(el, 'readyState', { get: () => 4 });
    Object.defineProperty(el, 'paused', { get: () => el._paused });
    Object.defineProperty(el, 'duration', { get: () => 200 });
    let vol = 1;
    Object.defineProperty(el, 'volume', {
      get: () => vol,
      set: (v: number) => {
        if (!(v >= 0 && v <= 1)) throw new DOMException('volume out of range', 'IndexSizeError');
        vol = v;
      },
    });
    el.play = vi.fn(async () => {
      el._paused = false;
    });
    el.pause = vi.fn(() => {
      el._paused = true;
    });
    el.load = vi.fn();
  }
  return els;
}

describe('crossfade', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ends with the new track at full volume even when the frame clock is behind', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now() - 30), 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const d = new DualAudio();
    const [a, b] = rig(d);
    d.volume = 0.7;
    d.src = 'http://x/a';
    await d.play();
    await d.crossfadeTo('http://x/b', 1);
    expect(d.isCrossfading).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(b.volume).toBeGreaterThan(0.2);
    expect(a.volume).toBeLessThan(0.7);
    await vi.advanceTimersByTimeAsync(800);
    expect(d.isCrossfading).toBe(false);
    expect(b.volume).toBeCloseTo(0.7);
    expect(b.paused).toBe(false);
    expect(a.paused).toBe(true);
  });

  it('still finishes when frames stop coming (hidden or occluded window)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const d = new DualAudio();
    const [, b] = rig(d);
    d.volume = 0.5;
    d.src = 'http://x/a';
    await d.play();
    await d.crossfadeTo('http://x/b', 2);
    await vi.advanceTimersByTimeAsync(2600);
    expect(d.isCrossfading).toBe(false);
    expect(b.volume).toBeCloseTo(0.5);
  });

  it('tells the ui the new length once the incoming deck takes over', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const d = new DualAudio();
    rig(d);
    const seen: string[] = [];
    d.addEventListener('durationchange', () => seen.push('durationchange'));
    d.src = 'http://x/a';
    await d.play();
    await d.crossfadeTo('http://x/b', 1);
    expect(seen).toContain('durationchange');
  });
});

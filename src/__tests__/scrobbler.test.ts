import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScrobbler } from '../plugins/scrobbler';

const info = (position: number) => ({
  id: 'abcdefghijk',
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  duration: 200,
  position,
  isPlaying: true,
});

describe('scrobbler', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());
  const listen = (s: number) => vi.setSystemTime(Date.now() + s * 1000);

  it('continues the listen counted in Rust instead of scrobbling twice', () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const p = createScrobbler({
      id: 'x',
      name: 'x',
      description: 'x',
      queueKey: 'test.queue',
      nowPlaying: vi.fn().mockResolvedValue(undefined),
      submit,
    });
    p.adopt({ id: 'abcdefghijk', listened: 90, done: false, start: Date.now(), duration: 200 });
    p.onTrackChange?.(info(90), null);
    listen(11);
    p.onPlayStateChange?.(false);
    expect(submit).toHaveBeenCalledTimes(1);
    p.adopt({ id: 'abcdefghijk', listened: 150, done: true, start: Date.now(), duration: 200 });
    p.onTrackChange?.(info(150), null);
    listen(40);
    p.onPlayStateChange?.(false);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(p.handoff()).toMatchObject({ id: 'abcdefghijk', done: true });
  });

  it('submits once after half of the track was actually heard', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const nowPlaying = vi.fn().mockResolvedValue(undefined);
    const p = createScrobbler({
      id: 'x',
      name: 'x',
      description: 'x',
      queueKey: 'test.queue',
      nowPlaying,
      submit,
    });
    p.onTrackChange?.(info(0), null);
    expect(nowPlaying).toHaveBeenCalledWith(expect.objectContaining({ video_id: 'abcdefghijk' }));
    p.onSeek?.(150);
    listen(50);
    p.onNowPlaying?.(info(200));
    expect(submit).not.toHaveBeenCalled();
    p.onPlayStateChange?.(false);
    listen(600);
    p.onPlayStateChange?.(true);
    expect(submit).not.toHaveBeenCalled();
    listen(51);
    p.onPlayStateChange?.(false);
    expect(submit).toHaveBeenCalledTimes(1);
    listen(30);
    p.onNowPlaying?.(info(120));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({ track: 'Blinding Lights', duration: 200 });
  });

  it('queues a failed listen and sends it on the next enable', async () => {
    localStorage.removeItem('test.q2');
    const submit = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const p = createScrobbler({
      id: 'x',
      name: 'x',
      description: 'x',
      queueKey: 'test.q2',
      nowPlaying: () => Promise.resolve(),
      submit,
    });
    p.onTrackChange?.(info(0), null);
    listen(101);
    p.onTrackChange?.(null, 'abcdefghijk');
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem('test.q2') || '[]')).toHaveLength(1)
    );
    p.onEnable?.();
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem('test.q2') || '[]')).toHaveLength(0)
    );
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('keeps a listen queued during a flush even when the queue is full', async () => {
    const key = 'test.q3';
    const old = Array.from({ length: 50 }, (_, i) => ({
      artist: 'a',
      track: `t${i}`,
      timestamp: i,
    }));
    localStorage.setItem(key, JSON.stringify(old));
    const late = { artist: 'b', track: 'late', timestamp: 999 };
    let added = false;
    const submit = vi.fn(async () => {
      if (!added) {
        added = true;
        const q = JSON.parse(localStorage.getItem(key) || '[]');
        localStorage.setItem(key, JSON.stringify([...q, late].slice(-50)));
      }
      throw new Error('offline');
    });
    const p = createScrobbler({
      id: 'x',
      name: 'x',
      description: 'x',
      queueKey: key,
      nowPlaying: () => Promise.resolve(),
      submit,
    });
    p.onEnable?.();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(50));
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(key) || '[]')).toContainEqual(late)
    );
  });
});

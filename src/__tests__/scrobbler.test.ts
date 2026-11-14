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
});

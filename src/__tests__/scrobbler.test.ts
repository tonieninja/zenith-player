import { describe, expect, it, vi } from 'vitest';
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
    for (let s = 150; s <= 200; s += 1) p.onNowPlaying?.(info(s));
    expect(submit).not.toHaveBeenCalled();
    p.onSeek?.(0);
    for (let s = 0; s <= 120; s += 1) p.onNowPlaying?.(info(s));
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
    for (let s = 0; s <= 101; s += 1) p.onNowPlaying?.(info(s));
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

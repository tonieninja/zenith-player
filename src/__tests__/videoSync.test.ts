import { describe, expect, it } from 'vitest';
import { proxiedId, videoStep, VIDEO_DRIFT_MAX } from '../audio/videoSync';

const clock = { t: 10, paused: false, buffering: false, rate: 1 };

describe('music video follows the audio clock', () => {
  it('seeks only past the drift threshold', () => {
    expect(videoStep(clock, 10 + VIDEO_DRIFT_MAX - 0.01).seekTo).toBeNull();
    expect(videoStep(clock, 9.75).seekTo).toBeNull();
    expect(videoStep(clock, 10.31).seekTo).toBe(10);
    expect(videoStep(clock, 2).seekTo).toBe(10);
  });

  it('pauses with the audio and while it buffers, copies the rate', () => {
    expect(videoStep(clock, 10).play).toBe(true);
    expect(videoStep({ ...clock, paused: true }, 10).play).toBe(false);
    expect(videoStep({ ...clock, buffering: true }, 10).play).toBe(false);
    expect(videoStep({ ...clock, rate: 1.25 }, 10).rate).toBe(1.25);
  });

  it('catches up a small lag by speed instead of leaving it', () => {
    expect(videoStep(clock, 9.79).rate).toBeCloseTo(1.05);
    expect(videoStep(clock, 10.2).rate).toBeCloseTo(0.95);
    expect(videoStep(clock, 10.02).rate).toBe(1);
    expect(videoStep({ ...clock, rate: 1.25 }, 9.8).rate).toBeCloseTo(1.3125);
  });

  it('reads the playing id from proxy and offline urls only', () => {
    expect(proxiedId('http://127.0.0.1:5123/zenith/ab12/kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
    expect(proxiedId('http://127.0.0.1:5123/offline/ab12/-4SQVBZNdEc')).toBe('-4SQVBZNdEc');
    expect(proxiedId('http://127.0.0.1:5123/zenith/ab12/kJQP7kiw5Fkx')).toBeNull();
    expect(proxiedId('https://r1.googlevideo.com/videoplayback?id=x')).toBeNull();
    expect(proxiedId('')).toBeNull();
  });
});

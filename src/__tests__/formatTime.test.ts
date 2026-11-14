import { describe, expect, it } from 'vitest';
import { formatTime } from '../utils/playback';

describe('long durations', () => {
  it('shows hours instead of LIVE for long recordings', () => {
    expect(formatTime(59 * 60 + 5)).toBe('59:05');
    expect(formatTime(9 * 3600 + 3 * 60 + 7)).toBe('9:03:07');
    expect(formatTime(Infinity)).toBe('0:00');
  });
});

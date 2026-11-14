import { describe, expect, it } from 'vitest';
import { trackLink } from '../plugins/copyTrackLink';

describe('trackLink', () => {
  it('is just the video id', () => {
    expect(trackLink('dQw4w9WgXcQ')).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('adds whole seconds only when past the start', () => {
    expect(trackLink('abc', 82.9)).toBe('https://music.youtube.com/watch?v=abc&t=82');
    expect(trackLink('abc', 0.4)).toBe('https://music.youtube.com/watch?v=abc');
  });
});

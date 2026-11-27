import { describe, expect, it } from 'vitest';
import { miniSize } from '../plugins/miniPlayer';

const all = { play: true, seek: true, prev: true, next: true, lyrics: false };

describe('miniSize', () => {
  it('fits the full set of buttons', () => {
    expect(miniSize(all)).toEqual({ w: 418, h: 96 });
  });

  it('shrinks by exactly the hidden parts', () => {
    expect(miniSize({ ...all, prev: false, next: false })).toEqual({ w: 338, h: 96 });
    expect(miniSize({ ...all, play: false, prev: false, next: false })).toEqual({ w: 272, h: 96 });
    expect(miniSize({ ...all, seek: false }).h).toBe(82);
  });

  it('adds the lyrics strip under the player', () => {
    expect(miniSize({ ...all, lyrics: true }).h).toBe(152);
  });
});

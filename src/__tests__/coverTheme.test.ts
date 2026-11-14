import { describe, expect, it } from 'vitest';
import { vividColor } from '../utils/coverTheme';

describe('vividColor', () => {
  it('keeps the hue and pushes it to full brightness', () => {
    expect(vividColor([120, 60, 60])).toEqual([255, 51, 51]);
    expect(vividColor([20, 60, 120])).toEqual([42, 127, 255]);
  });

  it('gives up on grey covers', () => {
    expect(vividColor([128, 128, 128])).toBeNull();
    expect(vividColor([0, 0, 0])).toBeNull();
  });

  it('leaves already saturated colours alone', () => {
    expect(vividColor([0, 255, 0])).toEqual([0, 255, 0]);
  });
});

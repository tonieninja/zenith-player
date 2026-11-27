import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCoverTheme, resetCoverTheme, vividColor } from '../utils/coverTheme';
import { applyTheme } from '../utils/themes';

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

describe('cover glow and accent theme', () => {
  const root = document.documentElement;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    root.classList.remove('has-cover-theme');
    root.removeAttribute('style');
  });

  it('a cover that loads after the glow is turned off changes nothing', () => {
    const images: { onload?: () => void }[] = [];
    vi.stubGlobal(
      'Image',
      class {
        onload?: () => void;
        constructor() {
          images.push(this);
        }
      }
    );
    const red = new Uint8ClampedArray(32 * 32 * 4).map((_, i) => [200, 40, 40, 255][i % 4]);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: () => undefined,
      getImageData: () => ({ data: red }),
    } as unknown as CanvasRenderingContext2D);
    applyCoverTheme('https://example.com/a.jpg');
    images[0].onload?.();
    expect(root.classList.contains('has-cover-theme')).toBe(true);
    applyCoverTheme('https://example.com/b.jpg');
    resetCoverTheme();
    images[1].onload?.();
    expect(root.classList.contains('has-cover-theme')).toBe(false);
  });

  it('picking a theme while the glow is on keeps the cover accent', () => {
    root.classList.add('has-cover-theme');
    root.style.setProperty('--accent-1', '#123456');
    applyTheme('violet');
    expect(root.style.getPropertyValue('--accent-1')).toBe('#123456');
    root.classList.remove('has-cover-theme');
    resetCoverTheme();
    expect(root.style.getPropertyValue('--accent-1')).not.toBe('#123456');
  });
});

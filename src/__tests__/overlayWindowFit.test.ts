import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/window', () => ({
  cursorPosition: async () => ({ x: 0, y: 0 }),
  getCurrentWindow: () => ({
    setSize: async () => {},
    innerPosition: async () => ({ x: 0, y: 0 }),
    scaleFactor: async () => 1,
    setIgnoreCursorEvents: async () => {},
  }),
}));
vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));

import {
  cursorHitsOverlayPanel,
  overlayWindowSize,
  pointInRoundedRect,
} from '../overlay/windowFit';

describe('overlay window fit', () => {
  it('sizes the native window to the visible panel, with a small floor', () => {
    expect(overlayWindowSize({ width: 520.4, height: 140.2 })).toEqual({
      width: 521,
      height: 141,
    });
    expect(overlayWindowSize({ width: 100, height: 40 })).toEqual({
      width: 360,
      height: 72,
    });
  });

  it('treats the empty corners of the rounded panel as outside', () => {
    expect(pointInRoundedRect(0, 0, 0, 0, 200, 100, 20)).toBe(false);
    expect(pointInRoundedRect(20, 20, 0, 0, 200, 100, 20)).toBe(true);
    expect(pointInRoundedRect(100, 50, 0, 0, 200, 100, 20)).toBe(true);
    expect(pointInRoundedRect(199, 1, 0, 0, 200, 100, 20)).toBe(false);
  });

  it('maps a desktop cursor into the overlay panel in logical pixels', () => {
    const panel = { left: 0, top: 0, right: 400, bottom: 140 };
    // 150% scale, window origin at (100, 200) physical
    expect(
      cursorHitsOverlayPanel({ x: 100 + 200 * 1.5, y: 200 + 70 * 1.5 }, { x: 100, y: 200 }, 1.5, panel),
    ).toBe(true);
    expect(
      cursorHitsOverlayPanel({ x: 100 + 2 * 1.5, y: 200 + 2 * 1.5 }, { x: 100, y: 200 }, 1.5, panel),
    ).toBe(false);
    expect(cursorHitsOverlayPanel({ x: 0, y: 0 }, { x: 100, y: 200 }, 1.5, panel)).toBe(false);
  });
});

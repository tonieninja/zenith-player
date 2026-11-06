import { LogicalSize } from '@tauri-apps/api/dpi';
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';

export const OVERLAY_MIN_WIDTH = 360;
export const OVERLAY_MIN_HEIGHT = 72;
export const OVERLAY_CORNER_RADIUS = 22;

export function overlayWindowSize(panel: { width: number; height: number }) {
  return {
    width: Math.max(OVERLAY_MIN_WIDTH, Math.ceil(panel.width)),
    height: Math.max(OVERLAY_MIN_HEIGHT, Math.ceil(panel.height)),
  };
}

export function pointInRoundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius = OVERLAY_CORNER_RADIUS,
): boolean {
  if (x < left || x > right || y < top || y > bottom) return false;
  const r = Math.max(0, Math.min(radius, (right - left) / 2, (bottom - top) / 2));
  const cx = x < left + r ? left + r : x > right - r ? right - r : x;
  const cy = y < top + r ? top + r : y > bottom - r ? bottom - r : y;
  if (cx === x || cy === y) return true;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

export function cursorHitsOverlayPanel(
  cursor: { x: number; y: number },
  windowOrigin: { x: number; y: number },
  scale: number,
  panel: { left: number; top: number; right: number; bottom: number },
  radius = OVERLAY_CORNER_RADIUS,
): boolean {
  if (!scale) return false;
  const localX = (cursor.x - windowOrigin.x) / scale;
  const localY = (cursor.y - windowOrigin.y) / scale;
  return pointInRoundedRect(
    localX,
    localY,
    panel.left,
    panel.top,
    panel.right,
    panel.bottom,
    radius,
  );
}

/** shrink the native window to the visible panel and click-through the empty chrome */
export function attachOverlayWindowFit(panel: HTMLElement): () => void {
  const win = getCurrentWindow();
  let stopped = false;
  let lastW = 0;
  let lastH = 0;
  let ignoring: boolean | null = null;

  const resize = async () => {
    if (stopped) return;
    const { width, height } = overlayWindowSize(panel.getBoundingClientRect());
    if (width === lastW && height === lastH) return;
    lastW = width;
    lastH = height;
    try {
      await win.setSize(new LogicalSize(width, height));
    } catch {}
  };

  const syncIgnore = async () => {
    if (stopped) return;
    try {
      const [cursor, origin, scale] = await Promise.all([
        cursorPosition(),
        win.innerPosition(),
        win.scaleFactor(),
      ]);
      const hit = cursorHitsOverlayPanel(
        cursor,
        origin,
        scale,
        panel.getBoundingClientRect(),
      );
      if (ignoring !== !hit) {
        ignoring = !hit;
        await win.setIgnoreCursorEvents(!hit);
      }
    } catch {}
  };

  const ro = new ResizeObserver(() => {
    void resize();
  });
  ro.observe(panel);
  void resize();

  let timer = 0;
  const loop = () => {
    void syncIgnore().finally(() => {
      if (!stopped) timer = window.setTimeout(loop, 40);
    });
  };
  loop();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    ro.disconnect();
    void win.setIgnoreCursorEvents(false).catch(() => {});
  };
}

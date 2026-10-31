/** volume change for one wheel event: 2% per mouse notch (1% with Shift), trackpads scale smoothly */
export const WHEEL_STEP = 0.02;
export const WHEEL_FINE_STEP = 0.01;

export interface WheelLike {
  deltaY: number;
  deltaX?: number;
  deltaMode?: number;
  shiftKey?: boolean;
}

export function wheelVolumeDelta(e: WheelLike): number {
  // Shift turns vertical wheels horizontal in some engines, so read whichever axis moved
  const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX ?? 0) ? e.deltaY : (e.deltaX ?? 0);
  if (!raw) return 0;
  const step = e.shiftKey ? WHEEL_FINE_STEP : WHEEL_STEP;
  // deltaMode 1 = lines (about 3 per notch), 2 = pages, 0 = pixels (about 100 per notch)
  const notches = e.deltaMode === 1 ? raw / 3 : e.deltaMode === 2 ? raw : raw / 100;
  // a mouse notch always counts as at least one full step, tiny trackpad deltas stay tiny
  const n =
    Math.abs(notches) >= 0.5
      ? Math.sign(notches) * Math.max(1, Math.round(Math.abs(notches)))
      : notches;
  return -n * step;
}

export function applyWheelVolume(current: number, e: WheelLike): number {
  const next = current + wheelVolumeDelta(e);
  return Math.round(Math.max(0, Math.min(1, next)) * 1000) / 1000;
}

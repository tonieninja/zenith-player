function isEditable(el: Element | null | undefined): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(
    type
  );
}

export function isTypingEvent(e: KeyboardEvent): boolean {
  if (e.isComposing || e.keyCode === 229) return true;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const node of path.length ? path : [e.target]) {
    if (isEditable(node as Element)) return true;
  }
  return typeof document !== 'undefined' && isEditable(document.activeElement);
}

export function isInsideDialog(e: KeyboardEvent): boolean {
  const t = e.target as Element | null;
  if (t && typeof t.closest === 'function') {
    if (t.closest('.global-modal-overlay, [role="dialog"]')) return true;
  }
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  return Boolean(active?.closest?.('.global-modal-overlay, [role="dialog"]'));
}

export const WHEEL_STEP = 0.02;
export const WHEEL_FINE_STEP = 0.01;

export interface WheelLike {
  deltaY: number;
  deltaX?: number;
  deltaMode?: number;
  shiftKey?: boolean;
}

export function wheelVolumeDelta(e: WheelLike): number {
  const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX ?? 0) ? e.deltaY : (e.deltaX ?? 0);
  if (!raw) return 0;
  const step = e.shiftKey ? WHEEL_FINE_STEP : WHEEL_STEP;
  const notches = e.deltaMode === 1 ? raw / 3 : e.deltaMode === 2 ? raw : raw / 100;
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

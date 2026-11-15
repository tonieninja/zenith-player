import type { KeyboardEvent } from 'react';

// Enter/Spacja klikają role="button"; klawisze z zagnieżdżonych przycisków (menu „⋯”) zostają przy nich
export function clickOnKey(e: KeyboardEvent<HTMLElement>) {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  e.currentTarget.click();
}

export function sliderKeyValue(key: string, value: number, step: number, max: number) {
  const clamp = (v: number) => Math.max(0, Math.min(max, v));
  if (key === 'ArrowRight' || key === 'ArrowUp') return clamp(value + step);
  if (key === 'ArrowLeft' || key === 'ArrowDown') return clamp(value - step);
  if (key === 'PageUp') return clamp(value + step * 4);
  if (key === 'PageDown') return clamp(value - step * 4);
  if (key === 'Home') return 0;
  if (key === 'End') return max;
  return null;
}

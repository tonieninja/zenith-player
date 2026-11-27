import { describe, expect, it, vi } from 'vitest';
import { applyAppearance, currentAppearance } from '../utils/appearance';

describe('appearance', () => {
  const root = document.documentElement;
  let osLight = true;
  let onChange: (() => void) | undefined;
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return osLight;
    },
    addEventListener: (_: string, f: () => void) => (onChange = f),
  }));

  it('defaults to dark and remembers the choice', () => {
    localStorage.removeItem('zenith_appearance');
    expect(currentAppearance()).toBe('dark');
    applyAppearance('light');
    expect(root.dataset.theme).toBe('light');
    applyAppearance('dark');
    expect(root.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('zenith_appearance')).toBe('dark');
  });

  it('system follows the OS live and tells listeners', () => {
    const seen = vi.fn();
    window.addEventListener('zenith-appearance', seen);
    applyAppearance('system');
    expect(root.dataset.theme).toBe('light');
    osLight = false;
    onChange?.();
    expect(root.dataset.theme).toBeUndefined();
    expect(seen).toHaveBeenCalledTimes(2);
    applyAppearance('dark');
    osLight = true;
    onChange?.();
    expect(root.dataset.theme).toBeUndefined();
  });
});

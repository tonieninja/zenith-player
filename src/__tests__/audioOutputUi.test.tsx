import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> =>
  cmd === 'zaudio_output_devices' ? ['Speakers', 'Headphones'] : undefined
);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string])),
}));

const { AudioOutputSettings } = await import('../components/AudioOutputSettings');
const { OUTPUT_DEVICE_KEY } = await import('../audio/engine');

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  localStorage.clear();
  invoke.mockClear();
  document.body.innerHTML = '';
});

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => createRoot(el).render(<AudioOutputSettings lang="en" />));
  return el;
}

const open = (el: HTMLElement) =>
  act(() => el.querySelector<HTMLElement>('.zen-select-trigger')!.click());
const options = (el: HTMLElement) =>
  [...el.querySelectorAll('[role="option"]')].map((o) => o.textContent);

describe('audio output setting', () => {
  it('lists devices, saves the pick and goes back to the system default', async () => {
    const el = await mount();
    open(el);
    expect(options(el)).toEqual(['System default', 'Speakers', 'Headphones']);
    act(() => [...el.querySelectorAll<HTMLElement>('[role="option"]')][2].click());
    expect(localStorage.getItem(OUTPUT_DEVICE_KEY)).toBe('Headphones');
    expect(invoke).toHaveBeenLastCalledWith('zaudio_set_output_device', { name: 'Headphones' });
    open(el);
    act(() => [...el.querySelectorAll<HTMLElement>('[role="option"]')][0].click());
    expect(localStorage.getItem(OUTPUT_DEVICE_KEY)).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith('zaudio_set_output_device', { name: null });
  });

  it('keeps an unplugged saved device visible instead of dropping it', async () => {
    localStorage.setItem(OUTPUT_DEVICE_KEY, 'USB DAC');
    const el = await mount();
    expect(el.querySelector('.zen-select-value')?.textContent).toBe('USB DAC (not connected)');
    open(el);
    expect(options(el)).toEqual([
      'System default',
      'Speakers',
      'Headphones',
      'USB DAC (not connected)',
    ]);
  });
});

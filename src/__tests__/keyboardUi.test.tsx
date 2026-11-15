import { act } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { clickOnKey, sliderKeyValue } from '../components/ui/keyboard';
import { PopoverMenu } from '../components/ui/PopoverMenu';
import { toastLifetime } from '../components/Toast';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('slider keys', () => {
  it('steps, jumps to the ends and clamps', () => {
    expect(sliderKeyValue('ArrowRight', 10, 5, 100)).toBe(15);
    expect(sliderKeyValue('ArrowDown', 2, 5, 100)).toBe(0);
    expect(sliderKeyValue('ArrowUp', 98, 5, 100)).toBe(100);
    expect(sliderKeyValue('PageDown', 50, 5, 100)).toBe(30);
    expect(sliderKeyValue('Home', 50, 5, 100)).toBe(0);
    expect(sliderKeyValue('End', 50, 5, 100)).toBe(100);
    expect(sliderKeyValue('a', 50, 5, 100)).toBeNull();
  });
});

describe('click on key', () => {
  it('clicks on Enter and Space, but not for keys from nested buttons', () => {
    const el = document.createElement('div');
    const onClick = vi.fn();
    el.addEventListener('click', onClick);
    const ev = (key: string, own = true) =>
      ({
        key,
        target: own ? el : document.createElement('button'),
        currentTarget: el,
        preventDefault: vi.fn(),
      }) as unknown as ReactKeyboardEvent<HTMLElement>;
    clickOnKey(ev('Enter'));
    clickOnKey(ev(' '));
    clickOnKey(ev('Enter', false));
    clickOnKey(ev('Tab'));
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe('popover menu keyboard', () => {
  it('moves focus into the menu, walks it with arrows and returns to the trigger', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const picked: string[] = [];
    await act(async () => {
      root.render(
        <PopoverMenu
          ariaLabel="Actions"
          trigger={<span>…</span>}
          items={[
            { key: 'a', label: 'Rename', onSelect: () => picked.push('a') },
            { key: 'b', label: 'Locked', disabled: true, onSelect: () => picked.push('b') },
            { key: 'c', label: 'Delete', onSelect: () => picked.push('c') },
          ]}
        />
      );
    });
    const trigger = host.querySelector('button') as HTMLButtonElement;
    await act(async () => trigger.click());
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(document.activeElement).toBe(items[0]);

    const key = (k: string) =>
      act(async () => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
        );
      });
    await key('ArrowDown');
    expect(document.activeElement).toBe(items[2]);
    await key('Enter');
    expect(picked).toEqual(['c']);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    await act(async () => trigger.click());
    await key('Escape');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => root.unmount());
    host.remove();
  });
});

describe('toast lifetime', () => {
  it('gives long and error messages time to be read', () => {
    expect(toastLifetime('Saved', 'success', 1800)).toBe(1800);
    expect(toastLifetime('x'.repeat(100), 'info', 3200)).toBe(7000);
    expect(toastLifetime('Failed', 'error', 3200)).toBe(6000);
    expect(toastLifetime('Queue cleared', 'success', 3200, true)).toBe(6000);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fillPages, LIBRARY_INITIAL_PAGES } from '../utils/libraryLoad';
import { acceleratorFromEvent } from '../plugins/globalHotkeys';

describe('fillPages', () => {
  it('stops after maxPages and reports leftover token', async () => {
    let calls = 0;
    const fetchPage = vi.fn(async (token: string) => {
      calls += 1;
      return {
        items: [{ id: `id-${token}` }],
        next: calls < 5 ? `t${calls}` : null,
      };
    });
    const out = await fillPages({
      initial: [{ id: 'seed' }],
      token: 't0',
      maxPages: LIBRARY_INITIAL_PAGES,
      fetchPage,
    });
    expect(out.pagesFetched).toBe(LIBRARY_INITIAL_PAGES);
    expect(out.items.map((i) => i.id)).toEqual(['seed', 'id-t0', 'id-t1']);
    expect(out.next).toBe('t2');
  });
});

describe('hotkey capture rejects clipboard combos', () => {
  it('blocks Ctrl+V / Ctrl+C', () => {
    expect(
      acceleratorFromEvent({
        key: 'v',
        code: 'KeyV',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      })
    ).toBeNull();
    expect(
      acceleratorFromEvent({
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      })
    ).toBeNull();
  });
  it('still allows Ctrl+Alt+V', () => {
    expect(
      acceleratorFromEvent({
        key: 'v',
        code: 'KeyV',
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
        metaKey: false,
      })
    ).toBe('Ctrl+Alt+KeyV');
  });
});

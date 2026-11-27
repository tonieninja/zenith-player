import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

import type { Track } from '../api/youtube';
import { HeroSection } from '../components/feed/HeroSection';
import { SearchBox } from '../components/search/SearchBox';
import { translations } from '../i18n';

const t: Record<string, string> = translations.en;
let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('search box', () => {
  it('lists recent searches on focus, walks them with arrows and removes one with Delete', async () => {
    localStorage.setItem('zenith_search_history', JSON.stringify(['one', 'two', 'three']));
    const onSearch = vi.fn();
    const input = createRef<HTMLInputElement>();
    await act(async () => {
      root.render(
        <SearchBox
          lang="en"
          t={t}
          inputRef={input}
          handleRef={null}
          onSearch={onSearch}
          onPick={vi.fn()}
        />
      );
    });
    const el = input.current!;
    const key = (k: string) =>
      act(async () => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      });
    const active = () => host.querySelector('.search-suggest-row.active')?.textContent;

    await act(async () => el.focus());
    expect([...host.querySelectorAll('.search-suggest-row')].map((r) => r.textContent)).toEqual([
      'one',
      'two',
      'three',
    ]);
    await key('ArrowUp');
    expect(active()).toBe('three');
    await key('ArrowDown');
    expect(active()).toBeUndefined();
    await key('ArrowDown');
    expect(active()).toBe('one');
    await key('Delete');
    expect(JSON.parse(localStorage.getItem('zenith_search_history')!)).toEqual(['two', 'three']);
    expect(active()).toBe('two');
    await key('Enter');
    expect(onSearch).toHaveBeenCalledWith('two');
    expect(el.value).toBe('two');
    expect(host.querySelector('.search-suggest')).toBeNull();
  });
});

describe('search top result', () => {
  it('offers Open instead of Play for a profile', async () => {
    const onOpen = vi.fn();
    const onPlay = vi.fn();
    const profile = { id: 'UCx', type: 'profile', title: 'Someone', artist: '' } as Track;
    await act(async () => {
      root.render(<HeroSection track={profile} onOpen={onOpen} onPlay={onPlay} t={t} />);
    });
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([t.openProfile]);
    await act(async () => buttons[0].click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
  });
});

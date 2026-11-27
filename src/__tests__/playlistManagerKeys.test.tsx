import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../api/playlistManager', async (orig) => ({
  ...(await orig<typeof import('../api/playlistManager')>()),
  listAllPlaylists: vi.fn(async () => [
    {
      id: 'VLPLtest',
      title: 'Lista testowa',
      subtitle: '',
      cover: '',
      count: 0,
      kind: 'created',
      editable: true,
    },
  ]),
  loadPlaylistDetails: vi.fn(async () => ({
    title: 'Lista testowa',
    description: '',
    privacy: 'PRIVATE',
    owned: true,
    entries: [],
  })),
}));

import { PlaylistManager } from '../components/PlaylistManager';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const escape = () =>
  act(
    () =>
      void document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
  );

describe('playlist manager Escape', () => {
  it('keeps unsaved edits and closes the delete prompt before the window', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <PlaylistManager lang="en" ownerName={null} onClose={onClose} onPlay={() => undefined} />
      )
    );
    await flush();
    const row = document.querySelector<HTMLButtonElement>('.pm-list-row')!;
    await act(async () => row.click());
    await flush();

    const title = document.querySelector<HTMLInputElement>('.pm-main input')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(title, 'Zmieniona nazwa');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    (document.activeElement as HTMLElement | null)?.blur();
    escape();
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      setValue.call(title, 'Lista testowa');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const del = [...document.querySelectorAll<HTMLButtonElement>('.pm-main button')].find((b) =>
      b.textContent?.includes('Delete')
    )!;
    act(() => del.click());
    expect(document.querySelector('.pm-dialog')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Cancel');
    escape();
    expect(document.querySelector('.pm-dialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    host.remove();
  });
});

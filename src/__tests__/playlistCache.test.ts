import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const fetchMock = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }));

import { invalidateLibraryCache, loadPlaylistItems, prefetchPlaylist } from '../api/youtube';

const row = (videoId: string) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: videoId }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Artist' }] } } },
    ],
  },
});
const page = (ids: string[], continuation?: string) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      secondaryContents: {
        sectionListRenderer: {
          contents: [
            {
              musicPlaylistShelfRenderer: {
                contents: [
                  ...ids.map(row),
                  ...(continuation
                    ? [
                        {
                          continuationItemRenderer: {
                            continuationEndpoint: { continuationCommand: { token: continuation } },
                          },
                        },
                      ]
                    : []),
                ],
              },
            },
          ],
        },
      },
    },
  },
});
const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

describe('playlist cache', () => {
  beforeEach(() => {
    invalidateLibraryCache();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json(page(['aaaaaaaaaaa', 'bbbbbbbbbbb'])));
  });

  it('opens the same playlist again without a request and still fills the view', async () => {
    const first = await loadPlaylistItems('VLPLcached', 'en');
    const onPage = vi.fn();
    const again = await loadPlaylistItems('VLPLcached', 'en', onPage);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again).toBe(first);
    expect(onPage).toHaveBeenCalledWith(first.items);
    await loadPlaylistItems('VLPLcached', 'en', undefined, undefined, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    invalidateLibraryCache();
    await loadPlaylistItems('VLPLcached', 'en');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never keeps liked songs, mixes or a list cut short', async () => {
    await loadPlaylistItems('VLLM', 'en');
    await loadPlaylistItems('VLLM', 'en');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(json(page(['aaaaaaaaaaa'], 'next-token')))
      .mockRejectedValueOnce(new Error('error sending request'))
      .mockResolvedValue(json(page(['aaaaaaaaaaa'])));
    expect((await loadPlaylistItems('VLPLpartial', 'en')).items).toHaveLength(1);
    await loadPlaylistItems('VLPLpartial', 'en');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a click after hovering waits for the hover request instead of sending another', async () => {
    prefetchPlaylist('VLPLhover', 'en');
    prefetchPlaylist('VLPLhover', 'en');
    const res = await loadPlaylistItems('VLPLhover', 'en');
    expect(res.items.map((t) => t.id)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

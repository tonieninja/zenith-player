import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn(async (cmd: string) => {
  if (cmd === 'get_ytm_cookies') return 'SAPISID=test-sapisid; __Secure-3PSID=test-psid';
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string) => invokeMock(cmd) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const fetchMock = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }));

import {
  addToPlaylist,
  AlreadyInPlaylistError,
  applyPlaylistOverrides,
  loadPlaylistItems,
  playlistContentRoot,
  rememberPlaylistDeleted,
  rememberPlaylistRenamed,
} from '../api/youtube';
import { loadPersistedQueue, savePersistedQueue } from '../plugins/queuePersist';

const item = (videoId: string, title: string) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Artist' }] } } },
    ],
  },
});

const playlistPage = (own: unknown[], suggestions: unknown[] = []) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      secondaryContents: {
        sectionListRenderer: {
          contents: [
            ...(own.length ? [{ musicPlaylistShelfRenderer: { contents: own } }] : []),
            ...(suggestions.length ? [{ musicShelfRenderer: { contents: suggestions } }] : []),
          ],
        },
      },
    },
  },
});

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

describe('playlist content', () => {
  it('reads only the playlist shelf, not the suggestions', () => {
    const page = playlistPage([item('aaaaaaaaaaa', 'Mine')], [item('bbbbbbbbbbb', 'Suggested')]);
    const root = playlistContentRoot(page, 'VLPLxyz');
    expect(JSON.stringify(root)).toContain('aaaaaaaaaaa');
    expect(JSON.stringify(root)).not.toContain('bbbbbbbbbbb');
  });

  it('treats a playlist with only suggestions as empty', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(playlistPage([], [item('bbbbbbbbbbb', 'Sug')])));
    const res = await loadPlaylistItems('VLPLempty', 'en');
    expect(res.status).toBe('empty');
    expect(res.items).toEqual([]);
  });

  it('reads podcast episodes from the episodes-for-later list', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      jsonResponse({
        contents: {
          sectionListRenderer: {
            contents: [
              {
                musicShelfRenderer: {
                  contents: [
                    {
                      musicMultiRowListItemRenderer: {
                        title: { runs: [{ text: 'Episode 1' }] },
                        subtitle: { runs: [{ text: 'Show' }] },
                        onTap: { watchEndpoint: { videoId: 'ccccccccccc' } },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      })
    );
    const res = await loadPlaylistItems('VLSE', 'en');
    expect(res.status).toBe('ok');
    expect(res.items.map((t) => t.id)).toEqual(['ccccccccccc']);
  });

  it('reports a failed request as failed, not empty', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => '' });
    expect((await loadPlaylistItems('VLPLx', 'en')).status).toBe('failed');
  });
});

describe('add to playlist', () => {
  beforeEach(() => fetchMock.mockReset());

  it('refuses a duplicate and does not call edit_playlist', async () => {
    fetchMock.mockResolvedValue(jsonResponse(playlistPage([item('aaaaaaaaaaa', 'Mine')])));
    await expect(addToPlaylist('PLxyz', 'aaaaaaaaaaa', 'en')).rejects.toBeInstanceOf(
      AlreadyInPlaylistError
    );
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('edit_playlist'))).toBe(false);
  });

  it('adds a new track, and a duplicate when asked to', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('edit_playlist')
        ? jsonResponse({ status: 'STATUS_SUCCEEDED' })
        : jsonResponse(playlistPage([item('aaaaaaaaaaa', 'Mine')]))
    );
    await addToPlaylist('PLxyz', 'ddddddddddd', 'en');
    await addToPlaylist('PLxyz', 'aaaaaaaaaaa', 'en', { allowDuplicate: true });
    const edits = fetchMock.mock.calls.filter((c) => String(c[0]).includes('edit_playlist'));
    expect(edits).toHaveLength(2);
    expect(String(edits[1][1].body)).not.toContain('DEDUPE_OPTION_SKIP');
  });
});

describe('playlist overrides', () => {
  it('hides deleted and renames renamed playlists for a while', () => {
    const now = 1_000_000;
    rememberPlaylistDeleted('VLPLgone', now);
    rememberPlaylistRenamed('PLren', 'New name', now);
    const list = [
      { id: 'VLPLgone', title: 'Gone' },
      { id: 'VLPLren', title: 'Old' },
      { id: 'VLPLkeep', title: 'Keep' },
    ];
    expect(applyPlaylistOverrides(list, now + 1000).map((p) => p.title)).toEqual([
      'New name',
      'Keep',
    ]);
    // after the server caught up the overrides expire
    expect(applyPlaylistOverrides(list, now + 11 * 60 * 1000)).toHaveLength(3);
  });
});

describe('queue persistence', () => {
  it('persists the playlist id behind "playing from"', () => {
    savePersistedQueue(
      [{ id: 'aaaaaaaaaaa', type: 'track', title: 't', artist: 'a', cover: '' }],
      0,
      'My list',
      0,
      false,
      'PLmine'
    );
    expect(loadPersistedQueue()?.playingFromId).toBe('PLmine');
  });
});

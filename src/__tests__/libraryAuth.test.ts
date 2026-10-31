import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) =>
    cmd === 'get_ytm_cookies' ? 'SAPISID=x; __Secure-3PSID=y; __Secure-3PAPISID=x' : null,
}));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const fetchMock = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }));

import { clearCaches, getLibrary, verifyYtmSession } from '../api/youtube';

const ctx = (loggedIn: '0' | '1') => ({
  serviceTrackingParams: [
    { service: 'GFEEDBACK', params: [{ key: 'logged_in', value: loggedIn }] },
  ],
});
const reply = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const twoRow = (id: string, title: string) => ({
  musicTwoRowItemRenderer: {
    title: {
      runs: [{ text: title, navigationEndpoint: { browseEndpoint: { browseId: 'VL' + id } } }],
    },
    subtitle: { runs: [{ text: 'Playlist' }] },
    navigationEndpoint: { browseEndpoint: { browseId: 'VL' + id } },
    thumbnailRenderer: {
      musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/x.jpg' }] } },
    },
  },
});

describe('signed-in library', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearCaches();
  });

  it('treats a menu answered as logged out as signed out', async () => {
    fetchMock.mockResolvedValue(
      reply({ responseContext: ctx('0'), actions: [{ multiPageMenuRenderer: {} }] })
    );
    expect(await verifyYtmSession('en')).toBe(false);
  });

  it('accepts a real signed-in menu', async () => {
    fetchMock.mockResolvedValue(
      reply({
        responseContext: ctx('1'),
        actions: [{ multiPageMenuRenderer: { accountItem: {} } }],
      })
    );
    expect(await verifyYtmSession('en')).toBe(true);
  });

  it('reads playlists from the grid shape', async () => {
    fetchMock.mockResolvedValue(
      reply({
        responseContext: ctx('1'),
        contents: {
          singleColumnBrowseResultsRenderer: {
            tabs: [
              {
                tabRenderer: {
                  content: {
                    sectionListRenderer: {
                      contents: [
                        {
                          gridRenderer: {
                            items: [twoRow('PLaaa', 'Gym'), twoRow('PLbbb', 'Sleepy')],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      })
    );
    const sections = await getLibrary('playlists', 'en');
    const titles = sections.flatMap((s) => s.items.map((i) => i.title));
    expect(titles).toEqual(expect.arrayContaining(['Gym', 'Sleepy']));
  });

  it('follows library continuations and maps library artists to channels', async () => {
    const row = (id: string, title: string) => ({
      musicResponsiveListItemRenderer: {
        navigationEndpoint: { browseEndpoint: { browseId: id } },
        flexColumns: [
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: '12 songs' }] } } },
        ],
      },
    });
    const first = {
      responseContext: ctx('1'),
      contents: {
        singleColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  sectionListRenderer: {
                    contents: [
                      {
                        musicShelfRenderer: {
                          contents: [
                            {
                              musicResponsiveListItemRenderer: {
                                flexColumns: [
                                  {
                                    musicResponsiveListItemFlexColumnRenderer: {
                                      text: { runs: [{ text: 'Shuffle all' }] },
                                    },
                                  },
                                ],
                                navigationEndpoint: {
                                  watchPlaylistEndpoint: { playlistId: 'MLCT', params: 'x' },
                                },
                              },
                            },
                            row('MPLAUCone', 'First'),
                          ],
                          continuations: [{ nextContinuationData: { continuation: 'tok1' } }],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    };
    const second = {
      continuationContents: {
        musicShelfContinuation: {
          contents: [row('MPLAUCtwo', 'Second')],
          continuations: [{ nextContinuationData: { continuation: 'tok2' } }],
        },
      },
    };
    const third = {
      continuationContents: { musicShelfContinuation: { contents: [row('MPLAUCthree', 'Third')] } },
    };
    fetchMock
      .mockResolvedValueOnce(reply(first))
      .mockResolvedValueOnce(reply(second))
      .mockResolvedValueOnce(reply(third));
    const sections = await getLibrary('artists', 'en');
    const items = sections.flatMap((s) => s.items);
    expect(items.map((i) => i.title)).toEqual(['First', 'Second', 'Third']);
    expect(items.every((i) => i.type === 'artist' && i.id.startsWith('UC'))).toBe(true);
  });
});

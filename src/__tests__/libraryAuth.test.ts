import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) =>
    cmd === 'get_ytm_cookies'
      ? 'SAPISID=x; __Secure-1PSID=y1; __Secure-3PSID=y; __Secure-1PAPISID=one; __Secure-3PAPISID=three'
      : null,
}));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const fetchMock = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }));

import {
  clearAuthCache,
  clearCaches,
  clearHomeBrowseCache,
  createPlaylist,
  extendLibrarySections,
  getAccountProfile,
  getHomeFeed,
  getLibrary,
  lastSessionCheckWasInconclusive,
  lastSessionCheckWasNetworkError,
  SessionExpiredError,
  verifyYtmSession,
} from '../api/youtube';

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

  it('a 401 is a real logout', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => '' });
    expect(await verifyYtmSession('en')).toBe(false);
    expect(lastSessionCheckWasInconclusive()).toBe(false);
    expect(lastSessionCheckWasNetworkError()).toBe(false);
  });

  it('a 403 keeps the session instead of calling it signed out', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'denied' });
    expect(await verifyYtmSession('en')).toBe(false);
    expect(lastSessionCheckWasInconclusive()).toBe(true);
    expect(lastSessionCheckWasNetworkError()).toBe(false);
  });

  it('reads the account name from the active account header', async () => {
    fetchMock.mockResolvedValue(
      reply({
        responseContext: ctx('1'),
        actions: [
          {
            openPopupAction: {
              popup: {
                multiPageMenuRenderer: {
                  header: {
                    activeAccountHeaderRenderer: {
                      accountName: { runs: [{ text: 'Ada Lovelace' }] },
                      email: { simpleText: 'ada@example.com' },
                      accountPhoto: { thumbnails: [{ url: 'https://i.ytimg.com/a.jpg' }] },
                    },
                  },
                },
              },
            },
          },
        ],
      })
    );
    const profile = await getAccountProfile('en');
    expect(profile?.name).toBe('Ada Lovelace');
    expect(profile?.email).toBe('ada@example.com');
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
    expect(items.map((i) => i.title)).toEqual(['First', 'Second']);
    const filled = await extendLibrarySections('artists', 'en', sections);
    const all = filled.flatMap((s) => s.items);
    expect(all.map((i) => i.title)).toEqual(['First', 'Second', 'Third']);
    expect(all.every((i) => i.type === 'artist' && i.id.startsWith('UC'))).toBe(true);
  });

  it('treats logged_in=1 as signed in even without account renderers', async () => {
    fetchMock.mockResolvedValue(reply({ responseContext: ctx('1') }));
    expect(await verifyYtmSession('en')).toBe(true);
  });

  it('does not treat a bare menu as signed in', async () => {
    fetchMock.mockResolvedValue(reply({ actions: [{ multiPageMenuRenderer: {} }] }));
    expect(await verifyYtmSession('en')).toBe(false);
  });
});

describe('playlist create', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearCaches();
    clearAuthCache();
  });

  it('sends the same auth headers as library calls and reads a nested playlist id', async () => {
    fetchMock.mockResolvedValue(
      reply({
        responseContext: ctx('1'),
        status: 'STATUS_SUCCEEDED',
        actions: [{ createPlaylistAction: { playlistId: 'VLPLcreatedxyz' } }],
      })
    );
    const id = await createPlaylist('ZenithQA401', '', 'PRIVATE', 'en');
    expect(id).toBe('PLcreatedxyz');
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('playlist/create');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^SAPISIDHASH /);
    expect(headers.Authorization).toContain('SAPISID1PHASH');
    expect(headers.Authorization).toContain('SAPISID3PHASH');
    expect(headers['X-Goog-AuthUser']).toBe('0');
    expect(headers['X-Origin']).toBe('https://music.youtube.com');
    expect(headers.Cookie).toContain('SAPISID=');
    expect(String(init.body)).toContain('ZenithQA401');
  });

  it('throws when youtube answers as logged out', async () => {
    fetchMock.mockResolvedValue(reply({ responseContext: ctx('0'), status: 'STATUS_SUCCEEDED' }));
    await expect(createPlaylist('Nope', '', 'PRIVATE', 'en')).rejects.toBeInstanceOf(
      SessionExpiredError
    );
  });
});

describe('home feed language', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearCaches();
    clearAuthCache();
  });

  it('does not keep a previous language heading after the cache is cleared', async () => {
    fetchMock.mockImplementation(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const hl = body?.context?.client?.hl;
      const title =
        hl === 'pl' ? 'Najnowsze wydania i największe hity w Polsce' : 'Latest releases';
      return reply({
        contents: {
          singleColumnBrowseResultsRenderer: {
            tabs: [
              {
                tabRenderer: {
                  content: {
                    sectionListRenderer: {
                      contents: [
                        {
                          musicCarouselShelfRenderer: {
                            header: {
                              musicCarouselShelfBasicHeaderRenderer: {
                                title: { runs: [{ text: title }] },
                              },
                            },
                            contents: [
                              {
                                musicTwoRowItemRenderer: {
                                  title: { runs: [{ text: 'A Hit' }] },
                                  subtitle: { runs: [{ text: 'Artist' }] },
                                  navigationEndpoint: { watchEndpoint: { videoId: 'abcdefghijk' } },
                                  thumbnailRenderer: {
                                    musicThumbnailRenderer: {
                                      thumbnail: {
                                        thumbnails: [{ url: 'https://i.ytimg.com/x.jpg' }],
                                      },
                                    },
                                  },
                                  lengthText: { runs: [{ text: '3:21' }] },
                                },
                              },
                            ],
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
      });
    });
    const pl = await getHomeFeed('pl');
    expect(pl.sections.map((s) => s.title)).toContain(
      'Najnowsze wydania i największe hity w Polsce'
    );
    expect(pl.sections[0].items[0].durationSec).toBe(201);
    clearHomeBrowseCache();
    const en = await getHomeFeed('en');
    expect(en.sections.map((s) => s.title)).toContain('Latest releases');
    expect(en.sections.map((s) => s.title)).not.toContain(
      'Najnowsze wydania i największe hity w Polsce'
    );
  });
});
